/* WebRTC transfer layer built on PeerJS.
   Supports a list of trusted peers; one live connection at a time, aimed at
   `targetId`. Incoming connections from any trusted peer are accepted.
   Protocol messages:
     {type:'hello'}                                — sent by the joining device during pairing
     {type:'paired'}                               — confirmation that pairing succeeded
     {type:'ping'} / {type:'pong'}                 — 30 s keepalive while the page is visible
     {type:'file-header', id, name, mime, size}    — announces an incoming file
     {type:'chunk', id, data:ArrayBuffer}          — 64 KB payload chunk
     {type:'file-complete', id}                    — sender finished; receiver verifies byte count
     {type:'ack', id}                              — receiver persisted the file; sender may delete it */
(function (scope) {
  'use strict';

  const CHUNK_SIZE = 64 * 1024;
  const BUFFER_HIGH = 1 * 1024 * 1024;  // pause sending above this
  const BUFFER_LOW = 256 * 1024;        // resume below this
  const PONG_STALE = 90 * 1000;         // no traffic for this long = connection is dead

  class Transfer {
    /* opts: myId, allowedIds (Set, shared & mutated by the app), targetId,
       events: onStatus(state, detail, peerId), onPairRequest(remoteId, accept),
       onPaired(remoteId), onFileReceived(record), onProgress(id, done, total, dir),
       onAcked(id), getOutbox(forPeerId) -> Promise<records>, persistIncoming(record) -> Promise */
    constructor(opts) {
      Object.assign(this, opts);
      this.peer = null;
      this.conn = null;
      this.incoming = new Map();   // fileId -> {meta, chunks, received}
      this.sending = false;
      this.dialTimer = null;
      this.pendingPair = null;     // peer ID we are trying to pair with (we dial + hello)
      this.pairingOpen = false;    // true while our pairing QR/code is on screen
      this.lastAlive = 0;
    }

    start() {
      this.onStatus('connecting', 'Registering with signaling server…', null);
      this.peer = new Peer(this.myId, { debug: 1 });

      this.peer.on('open', () => {
        this.onStatus('online', 'Registered. Waiting for peer…', null);
        this.dialLoop();
      });

      this.peer.on('connection', (conn) => this.adoptConnection(conn, true));

      this.peer.on('disconnected', () => {
        this.onStatus('connecting', 'Signaling lost, reconnecting…', null);
        try { this.peer.reconnect(); } catch (e) { /* destroyed */ }
      });

      this.peer.on('error', (err) => {
        // 'peer-unavailable' just means the other device isn't open right now.
        if (err.type === 'peer-unavailable') return;
        this.onStatus('error', err.type || String(err), null);
        // PeerJS destroys the Peer on fatal errors (e.g. 'unavailable-id' when
        // the broker still holds a ghost session after a quick reload).
        // Re-register from scratch after a short wait.
        if (this.peer && this.peer.destroyed) this.restartSoon();
      });
    }

    restartSoon() {
      if (this.restartTimer) return;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        clearInterval(this.dialTimer);
        this.conn = null;
        try { this.peer && this.peer.destroy(); } catch (e) {}
        this.start();
      }, 10000);
    }

    connOpen() { return this.conn && this.conn.open; }
    connectedPeer() { return this.connOpen() ? this.conn.peer : null; }
    isAllowed(id) { return this.allowedIds.has(id) || id === this.pendingPair; }

    /* Switch which peer we dial. Closes a live connection to a different peer. */
    setTarget(id) {
      this.targetId = id;
      if (this.conn && this.conn.peer !== id) { try { this.conn.close(); } catch (e) {} this.conn = null; }
      this.dialNow();
    }

    /* One-time pairing: dial this ID and introduce ourselves. */
    pairWith(id) {
      this.pendingPair = id;
      this.setTarget(id);
    }

    dialNow() {
      if (!this.targetId || this.conn || !this.peer || this.peer.disconnected) return;
      this.adoptConnection(this.peer.connect(this.targetId, { reliable: true }), false);
    }

    dialLoop() {
      this.dialNow();
      clearInterval(this.dialTimer);
      this.dialTimer = setInterval(() => this.dialNow(), 5000);
    }

    /* Called every 30 s by the app while the page is visible: keeps the data
       channel and NAT mappings warm, detects dead connections, redials. */
    keepalive(visible) {
      if (!visible) return;
      if (this.peer && this.peer.destroyed) { this.restartSoon(); return; }
      if (this.peer && this.peer.disconnected) {
        try { this.peer.reconnect(); } catch (e) {}
      }
      if (this.connOpen()) {
        if (Date.now() - this.lastAlive > PONG_STALE) {
          try { this.conn.close(); } catch (e) {}
          this.conn = null;
          this.dialNow();
          return;
        }
        this.conn.send({ type: 'ping' });
      } else {
        this.dialNow();
      }
    }

    adoptConnection(conn, isIncoming) {
      if (isIncoming && !this.isAllowed(conn.peer) && !this.pairingOpen) {
        conn.close();
        return;
      }
      if (this.conn) {
        // Keep an open connection; on a simultaneous-dial tie with the same
        // peer, the lower ID's outgoing attempt wins.
        const samePeer = this.conn.peer === conn.peer;
        const keepExisting = this.conn.open || !isIncoming || (samePeer && this.myId < conn.peer);
        if (keepExisting) { conn.close(); return; }
        try { this.conn.close(); } catch (e) {}
      }

      this.conn = conn;
      conn.on('open', () => {
        this.lastAlive = Date.now();
        if (this.pendingPair === conn.peer) conn.send({ type: 'hello' });
        this.onStatus('connected', 'Peer connected', conn.peer);
        this.drain();
      });
      conn.on('data', (msg) => this.handleMessage(conn, msg));
      conn.on('close', () => {
        if (this.conn === conn) this.conn = null;
        this.onStatus('online', 'Peer disconnected', null);
      });
      conn.on('error', () => {
        if (this.conn === conn) this.conn = null;
      });
    }

    async handleMessage(conn, msg) {
      if (!msg || typeof msg !== 'object') return;
      this.lastAlive = Date.now();
      switch (msg.type) {
        case 'ping':
          conn.send({ type: 'pong' });
          return;
        case 'pong':
          return;
        case 'hello': {
          if (this.isAllowed(conn.peer)) {
            conn.send({ type: 'paired' }); // already trusted — re-confirm silently
            return;
          }
          this.onPairRequest(conn.peer, (accepted) => {
            if (accepted) {
              conn.send({ type: 'paired' });
              this.drain();
            } else {
              conn.close();
            }
          });
          return;
        }
        case 'paired':
          this.pendingPair = null;
          this.onPaired && this.onPaired(conn.peer);
          return;
        case 'file-header':
          this.incoming.set(msg.id, {
            meta: { id: msg.id, name: msg.name, mime: msg.mime, size: msg.size },
            chunks: [],
            received: 0,
          });
          return;
        case 'chunk': {
          const entry = this.incoming.get(msg.id);
          if (!entry) return;
          const data = msg.data instanceof ArrayBuffer ? msg.data : msg.data.buffer;
          entry.chunks.push(data);
          entry.received += data.byteLength;
          this.onProgress && this.onProgress(msg.id, entry.received, entry.meta.size, 'receiving');
          return;
        }
        case 'file-complete': {
          const entry = this.incoming.get(msg.id);
          if (!entry) return;
          this.incoming.delete(msg.id);
          if (entry.received !== entry.meta.size) {
            this.onStatus('error', `Size mismatch for ${entry.meta.name} (got ${entry.received}, expected ${entry.meta.size})`, conn.peer);
            return;
          }
          const record = {
            ...entry.meta,
            blob: new Blob(entry.chunks, { type: entry.meta.mime }),
            from: conn.peer,
            receivedAt: Date.now(),
          };
          // Persist before acking so the sender never deletes a file we could lose.
          await this.persistIncoming(record);
          conn.send({ type: 'ack', id: record.id });
          this.onFileReceived(record);
          return;
        }
        case 'ack':
          this.onAcked(msg.id);
          return;
      }
    }

    /* Send every outbox file destined for the connected peer. Safe to call repeatedly. */
    async drain() {
      if (this.sending || !this.connOpen()) return;
      this.sending = true;
      try {
        const queue = await this.getOutbox(this.conn.peer);
        for (const record of queue) {
          if (!this.connOpen()) break;
          await this.sendFile(record);
        }
      } finally {
        this.sending = false;
      }
    }

    async sendFile(record) {
      const conn = this.conn;
      conn.send({ type: 'file-header', id: record.id, name: record.name, mime: record.mime, size: record.size });
      const buffer = await record.blob.arrayBuffer();
      for (let offset = 0; offset < buffer.byteLength; offset += CHUNK_SIZE) {
        if (!conn.open) return;
        conn.send({ type: 'chunk', id: record.id, data: buffer.slice(offset, offset + CHUNK_SIZE) });
        this.onProgress && this.onProgress(record.id, Math.min(offset + CHUNK_SIZE, buffer.byteLength), buffer.byteLength, 'sending');
        await this.waitForBuffer(conn);
      }
      if (conn.open) conn.send({ type: 'file-complete', id: record.id });
    }

    waitForBuffer(conn) {
      const dc = conn.dataChannel;
      if (!dc || dc.bufferedAmount < BUFFER_HIGH) return Promise.resolve();
      return new Promise((resolve) => {
        const poll = setInterval(() => {
          if (!conn.open || dc.bufferedAmount < BUFFER_LOW) {
            clearInterval(poll);
            resolve();
          }
        }, 50);
      });
    }
  }

  scope.Transfer = Transfer;
})(self);

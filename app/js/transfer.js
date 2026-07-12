/* WebRTC transfer layer built on PeerJS.
   Protocol (all messages over one bidirectional DataConnection):
     {type:'hello'}                                — sent by tablet during one-time pairing
     {type:'paired'}                               — desktop's confirmation that pairing succeeded
     {type:'file-header', id, name, mime, size}    — announces an incoming file
     {type:'chunk', id, data:ArrayBuffer}          — 64 KB payload chunk
     {type:'file-complete', id}                    — sender finished; receiver verifies byte count
     {type:'ack', id}                              — receiver persisted the file; sender may delete it */
(function (scope) {
  'use strict';

  const CHUNK_SIZE = 64 * 1024;
  const BUFFER_HIGH = 1 * 1024 * 1024;  // pause sending above this
  const BUFFER_LOW = 256 * 1024;        // resume below this

  class Transfer {
    /* opts: myId, trustedId (null while pairing), events:
       onStatus(state, detail), onPairRequest(remoteId, accept), onPaired(),
       onFileReceived(record), onProgress(id, sent, total), onAcked(id),
       getOutbox() -> Promise<records>, persistIncoming(record) -> Promise */
    constructor(opts) {
      Object.assign(this, opts);
      this.peer = null;
      this.conn = null;
      this.incoming = new Map();   // id -> {meta, chunks, received}
      this.sending = false;
      this.dialTimer = null;
    }

    start() {
      this.onStatus('connecting', 'Registering with signaling server…');
      this.peer = new Peer(this.myId, { debug: 1 });

      this.peer.on('open', () => {
        this.onStatus('online', 'Registered. Waiting for peer…');
        if (this.trustedId) this.dialLoop();
      });

      this.peer.on('connection', (conn) => this.adoptConnection(conn, true));

      this.peer.on('disconnected', () => {
        this.onStatus('connecting', 'Signaling lost, reconnecting…');
        try { this.peer.reconnect(); } catch (e) { /* destroyed */ }
      });

      this.peer.on('error', (err) => {
        // 'peer-unavailable' just means the other device isn't open right now.
        if (err.type === 'peer-unavailable') return;
        this.onStatus('error', err.type || String(err));
      });
    }

    /* The tablet (or any device that knows its peer's ID) dials; retry until connected. */
    dialLoop() {
      const dial = () => {
        if (!this.trustedId || this.connOpen() || !this.peer || this.peer.disconnected) return;
        const conn = this.peer.connect(this.trustedId, { reliable: true });
        this.adoptConnection(conn, false);
      };
      dial();
      clearInterval(this.dialTimer);
      this.dialTimer = setInterval(dial, 5000);
    }

    connOpen() { return this.conn && this.conn.open; }

    adoptConnection(conn, isIncoming) {
      // Reject strangers once paired. Before pairing, incoming connections are
      // pair requests and go through user confirmation below.
      if (isIncoming && this.trustedId && conn.peer !== this.trustedId) {
        conn.close();
        return;
      }
      if (this.connOpen()) { conn.close(); return; } // one connection at a time

      this.conn = conn;
      conn.on('open', () => {
        this.onStatus('connected', 'Peer connected');
        this.drain();
      });
      conn.on('data', (msg) => this.handleMessage(conn, msg));
      conn.on('close', () => {
        if (this.conn === conn) this.conn = null;
        this.onStatus('online', 'Peer disconnected');
      });
      conn.on('error', () => {
        if (this.conn === conn) this.conn = null;
      });
    }

    async handleMessage(conn, msg) {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'hello': {
          if (this.trustedId) {
            // Already paired with this device — re-confirm silently.
            if (conn.peer === this.trustedId) conn.send({ type: 'paired' });
            return;
          }
          this.onPairRequest(conn.peer, (accepted) => {
            if (accepted) {
              this.trustedId = conn.peer;
              conn.send({ type: 'paired' });
              this.drain();
            } else {
              conn.close();
            }
          });
          return;
        }
        case 'paired':
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
            this.onStatus('error', `Size mismatch for ${entry.meta.name} (got ${entry.received}, expected ${entry.meta.size})`);
            return;
          }
          const record = {
            ...entry.meta,
            blob: new Blob(entry.chunks, { type: entry.meta.mime }),
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

    sendHello() {
      if (this.connOpen()) this.conn.send({ type: 'hello' });
    }

    /* Send every queued outbox file, one at a time. Safe to call repeatedly. */
    async drain() {
      if (this.sending || !this.connOpen()) return;
      this.sending = true;
      try {
        const queue = await this.getOutbox();
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

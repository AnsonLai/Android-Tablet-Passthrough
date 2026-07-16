/* WebRTC transfer layer built on PeerJS.
   Supports a list of trusted peers; one live connection at a time, aimed at
   `targetId`. Incoming connections from any trusted peer are accepted.
   Protocol messages:
     {type:'hello'}                                — sent by the joining device during pairing
     {type:'paired'}                               — confirmation that pairing succeeded
     {type:'ping'} / {type:'pong'}                 — 30 s keepalive while the page is visible
     {type:'file-header', id, name, mime, size}    — announces an incoming file
     {type:'chunk', id, data:ArrayBuffer}          — 64 KB payload chunk (shared by files & clip images)
     {type:'file-complete', id}                    — sender finished; receiver verifies byte count
     {type:'ack', id}                              — receiver persisted the file; sender may delete it
     {type:'clip-meta', textUpdatedAt, imageUpdatedAt} — sent on connect; each side pushes whichever
                                                          of its own fields is newer than what's reported
     {type:'clip-text', text, updatedAt}           — shared-clipboard text, applied if newer than local
     {type:'clip-image-header', id, mime, size, updatedAt} — announces a shared-clipboard image
     {type:'clip-image-complete', id}              — image finished; applied if newer than local */
(function (scope) {
  'use strict';

  const CHUNK_SIZE = 64 * 1024;
  const BUFFER_HIGH = 1 * 1024 * 1024;  // pause sending above this
  const BUFFER_LOW = 256 * 1024;        // resume below this
  const PONG_STALE = 90 * 1000;         // no traffic for this long = connection is dead

  /* Cross-network connections (tablet on mobile data, PC on home Wi-Fi) need a
     TURN relay: mobile carriers use CGNAT, which STUN alone cannot traverse.
     The old anonymous Open Relay (openrelay.metered.ca / "openrelayproject")
     was shut down, so credentials now come from our Cloudflare Worker, which
     keeps the TURN API token secret and mints 24 h credentials on demand —
     setup in cloudflare-worker/README.md. Paste the deployed Worker URL here,
     e.g. https://atp-turn.YOURNAME.workers.dev
     Leave empty to run STUN-only (same-network connections still work). */
  const TURN_CREDENTIALS_URL = 'https://android-tablet-passthrough-github.ansonhwlai.workers.dev';

  const ICE_MAX_AGE = 12 * 60 * 60 * 1000; // refetch well inside the 24 h credential TTL

  const STUN_ONLY = [{ urls: 'stun:stun.l.google.com:19302' }];

  /* The Worker returns a ready-to-use iceServers array with fresh short-lived
     TURN credentials. Falls back to STUN-only on any failure so a dead TURN
     provider degrades to same-network operation instead of breaking
     registration entirely. */
  async function fetchIceServers() {
    if (!TURN_CREDENTIALS_URL) {
      console.warn('[atp] No TURN_CREDENTIALS_URL configured — cross-network connections will not work.');
      return STUN_ONLY;
    }
    try {
      const res = await fetch(TURN_CREDENTIALS_URL);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const servers = await res.json();
      if (!Array.isArray(servers) || servers.length === 0) throw new Error('empty iceServers');
      return servers;
    } catch (e) {
      console.error('[atp] TURN credential fetch failed, falling back to STUN only:', e);
      return STUN_ONLY;
    }
  }

  class Transfer {
    /* opts: myId, allowedIds (Set, shared & mutated by the app), targetId,
       events: onStatus(state, detail, peerId), onPairRequest(remoteId, accept),
       onPaired(remoteId), onConnected(peerId), onFileReceived(record), onProgress(id, done, total, dir),
       onAcked(id), getOutbox(forPeerId) -> Promise<records>, persistIncoming(record) -> Promise,
       onClipMeta(msg), onClipText(text, updatedAt, fromPeer), onClipImage(blob, mime, updatedAt, fromPeer),
       onClipProgress(dir, done, total) */
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
      // Start STUN-only: most connections are same-network and don't need a
      // relay. TURN credentials are fetched on demand — see escalateToTurn() —
      // only once a dial actually stalls, so the Worker/relay is never touched
      // for a connection that direct STUN can already handle.
      this.turnFetched = false;
      this.escalatingTurn = false;
      this.peer = new Peer(this.myId, {
        debug: 1,
        // TURN relays the traffic but can't read it: WebRTC data channels are
        // end-to-end encrypted (DTLS).
        config: { iceServers: STUN_ONLY }
      });

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
        // 'peer-unavailable' just means the other device isn't registered yet.
        // Drop the dead pending dial immediately so the next tick retries at
        // once, instead of holding it until the stuck-timeout (which was
        // adding 15+ s of dead air to first pairing).
        if (err.type === 'peer-unavailable') {
          if (this.conn && !this.conn.open) { try { this.conn.close(); } catch (e) { } this.conn = null; }
          return;
        }
        this.onStatus('error', err.type || String(err), null);
        // PeerJS destroys the Peer on fatal errors (e.g. 'unavailable-id' when
        // the broker still holds a ghost session after a quick reload).
        // Re-register from scratch after a short wait.
        if (this.peer && this.peer.destroyed) this.restartSoon();
      });
    }

    /* Called once a dial has stalled past the STUN-only backstop — a real
       sign the direct path isn't working. Mutating peer.options.config is
       enough: PeerJS reads it fresh for each new RTCPeerConnection, so every
       dial attempt after this one (this session) gets the relay. */
    escalateToTurn() {
      if (!TURN_CREDENTIALS_URL || this.turnFetched || this.escalatingTurn || !this.peer) return;
      this.escalatingTurn = true;
      fetchIceServers().then((servers) => {
        this.escalatingTurn = false;
        if (!this.peer) return;
        this.turnFetched = true;
        this.iceFetchedAt = Date.now();
        this.peer.options.config.iceServers = servers;
      });
    }

    restartSoon() {
      if (this.restartTimer) return;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        clearInterval(this.dialTimer);
        this.conn = null;
        try { this.peer && this.peer.destroy(); } catch (e) { }
        this.start();
      }, 10000);
    }

    connOpen() { return this.conn && this.conn.open; }
    connectedPeer() { return this.connOpen() ? this.conn.peer : null; }
    isAllowed(id) { return this.allowedIds.has(id) || id === this.pendingPair; }

    /* Switch which peer we dial. Closes a live connection to a different peer. */
    setTarget(id) {
      this.targetId = id;
      if (this.conn && this.conn.peer !== id) { try { this.conn.close(); } catch (e) { } this.conn = null; }
      this.dialNow();
    }

    /* One-time pairing: dial this ID and introduce ourselves. */
    pairWith(id) {
      this.pendingPair = id;
      this.setTarget(id);
    }

    dialNow() {
      // peer.open check matters: connect() before broker registration yields
      // a dead connection object that never opens and never errors.
      if (!this.targetId || this.conn || !this.peer || !this.peer.open) return;
      this.adoptConnection(this.peer.connect(this.targetId, { reliable: true }), false);
    }

    dialLoop() {
      this.dialNow();
      clearInterval(this.dialTimer);
      this.dialTimer = setInterval(() => {
        // Backstop for a dial that goes silent without a 'peer-unavailable'
        // error. Before TURN is fetched, 6 s is generous for same-network
        // negotiation (1–3 s) — a stall past that means direct/STUN can't
        // reach the peer, so it's the signal to escalate. Once TURN is in
        // play, allow up to 12 s: a relayed handshake over mobile data
        // (CGNAT) can take 8–10 s, and killing it early guarantees
        // cross-network never connects.
        const stallLimit = this.turnFetched ? 12000 : 6000;
        if (this.conn && !this.conn.open && Date.now() - this.connStartedAt > stallLimit) {
          if (!this.turnFetched) this.escalateToTurn();
          try { this.conn.close(); } catch (e) { }
          this.conn = null;
        }
        this.dialNow();
      }, 2000);
    }

    /* Called every 30 s by the app while the page is visible: keeps the data
       channel and NAT mappings warm, detects dead connections, redials. */
    keepalive(visible) {
      // Broker registration is maintained even while hidden — background-tab
      // timer throttling starves PeerJS's heartbeat and the broker drops us,
      // which made the desktop unreachable for pairing/transfers.
      if (this.peer && this.peer.destroyed) { this.restartSoon(); return; }
      if (this.peer && this.peer.disconnected) {
        try { this.peer.reconnect(); } catch (e) { }
      }
      // Refresh TURN credentials before their 24 h TTL runs out — only if this
      // session actually escalated to TURN; a connection that never needed a
      // relay has no credentials to expire. PeerJS reads peer.options.config
      // when it builds each new RTCPeerConnection, so updating it here covers
      // every future dial; the currently open connection keeps its old
      // allocation until it drops, then the redial picks up the fresh one.
      if (TURN_CREDENTIALS_URL && this.turnFetched && this.peer && Date.now() - this.iceFetchedAt > ICE_MAX_AGE) {
        this.iceFetchedAt = Date.now(); // set first so overlapping ticks don't double-fetch
        fetchIceServers().then((servers) => {
          if (this.peer) this.peer.options.config.iceServers = servers;
        });
      }
      if (!visible) return;
      if (this.connOpen()) {
        if (Date.now() - this.lastAlive > PONG_STALE) {
          try { this.conn.close(); } catch (e) { }
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
        const samePeer = this.conn.peer === conn.peer;
        // While our pairing screen is open, an inbound connection from a
        // different device is exactly what we're waiting for. Preempt the
        // live active-peer connection to take it — otherwise a device that's
        // already connected can never accept a second device's pairing.
        const pairingPreempt = this.pairingOpen && isIncoming && !samePeer && !this.isAllowed(conn.peer);
        if ((samePeer && isIncoming && this.conn.open) || pairingPreempt) {
          // Same-peer: the remote restarted and its old link is dead even
          // though WebRTC hasn't noticed. Either way, take the fresh one.
          try { this.conn.close(); } catch (e) { }
        } else {
          // Keep an open connection; on a simultaneous-dial tie with the same
          // peer, the lower ID's outgoing attempt wins.
          const keepExisting = this.conn.open || !isIncoming || (samePeer && this.myId < conn.peer);
          if (keepExisting) { conn.close(); return; }
          try { this.conn.close(); } catch (e) { }
        }
      }

      this.conn = conn;
      this.connStartedAt = Date.now();
      conn.on('open', () => {
        this.lastAlive = Date.now();
        if (this.pendingPair === conn.peer) {
          // Repeat the introduction until the other side confirms — a single
          // hello is lost if the peer's page is frozen or the link drops.
          clearInterval(this.helloTimer);
          this.helloTimer = setInterval(() => {
            if (this.pendingPair !== conn.peer || !conn.open) { clearInterval(this.helloTimer); return; }
            try { conn.send({ type: 'hello' }); } catch (e) { }
          }, 4000);
          try { conn.send({ type: 'hello' }); } catch (e) { }
        }
        this.onStatus('connected', 'Peer connected', conn.peer);
        this.drain();
        this.onConnected && this.onConnected(conn.peer);
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
            try { conn.send({ type: 'paired' }); } catch (e) { } // already trusted — re-confirm silently
            return;
          }
          this.onPairRequest(conn.peer, (accepted) => {
            if (accepted) {
              try { conn.send({ type: 'paired' }); } catch (e) { }
              this.drain();
            } else {
              conn.close();
            }
          });
          return;
        }
        case 'paired':
          this.pendingPair = null;
          clearInterval(this.helloTimer);
          this.onPaired && this.onPaired(conn.peer);
          return;
        case 'file-header':
          this.incoming.set(msg.id, {
            kind: 'file',
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
          if (entry.kind === 'clip-image') this.onClipProgress && this.onClipProgress('receiving', entry.received, entry.meta.size);
          else this.onProgress && this.onProgress(msg.id, entry.received, entry.meta.size, 'receiving');
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
        case 'clip-meta':
          this.onClipMeta && this.onClipMeta(msg);
          return;
        case 'clip-text':
          this.onClipText && this.onClipText(msg.text, msg.updatedAt, conn.peer);
          return;
        case 'clip-image-header':
          this.incoming.set(msg.id, {
            kind: 'clip-image',
            meta: { id: msg.id, mime: msg.mime, size: msg.size, updatedAt: msg.updatedAt },
            chunks: [],
            received: 0,
          });
          return;
        case 'clip-image-complete': {
          const entry = this.incoming.get(msg.id);
          if (!entry) return;
          this.incoming.delete(msg.id);
          if (entry.received !== entry.meta.size) return; // dropped mid-transfer; peer's next connect will retry
          const blob = new Blob(entry.chunks, { type: entry.meta.mime });
          this.onClipImage && this.onClipImage(blob, entry.meta.mime, entry.meta.updatedAt, conn.peer);
          return;
        }
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
      const sent = await this.sendChunks(conn, record.id, record.blob,
        (done, total) => this.onProgress && this.onProgress(record.id, done, total, 'sending'));
      if (sent) conn.send({ type: 'file-complete', id: record.id });
    }

    /* Shared by sendFile and sendClipImage: streams a blob as 'chunk' messages,
       throttled via bufferedAmount. Returns whether the connection was still
       open at the end (i.e. whether the caller should send its own *-complete). */
    async sendChunks(conn, id, blob, onChunkProgress) {
      const buffer = await blob.arrayBuffer();
      for (let offset = 0; offset < buffer.byteLength; offset += CHUNK_SIZE) {
        if (!conn.open) return false;
        conn.send({ type: 'chunk', id, data: buffer.slice(offset, offset + CHUNK_SIZE) });
        if (onChunkProgress) onChunkProgress(Math.min(offset + CHUNK_SIZE, buffer.byteLength), buffer.byteLength);
        await this.waitForBuffer(conn);
      }
      return conn.open;
    }

    /* ---------- shared clipboard ---------- */

    sendClipMeta(meta) {
      if (!this.connOpen()) return;
      this.conn.send({ type: 'clip-meta', ...meta });
    }

    sendClipText(text, updatedAt) {
      if (!this.connOpen()) return;
      this.conn.send({ type: 'clip-text', text, updatedAt });
    }

    async sendClipImage(id, blob, mime, updatedAt) {
      if (!this.connOpen()) return;
      const conn = this.conn;
      conn.send({ type: 'clip-image-header', id, mime, size: blob.size, updatedAt });
      const sent = await this.sendChunks(conn, id, blob,
        (done, total) => this.onClipProgress && this.onClipProgress('sending', done, total));
      if (sent) conn.send({ type: 'clip-image-complete', id });
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

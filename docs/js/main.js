/* App bootstrap, pairing flow, and UI for both roles. */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const db = self.ATPDB;

  const MAX_PEERS = 8;
  const KEEPALIVE_MS = 30 * 1000;

  const state = {
    role: null,          // 'desktop' | 'tablet'
    myId: null,
    peers: [],           // [{id, label, addedAt}]
    activePeer: null,    // id of the peer we dial / queue files for
    connectedPeer: null, // id of the peer currently connected, or null
    allowedIds: new Set(),
    transfer: null,
    progress: new Map(), // fileId -> {done, total, dir}
  };

  const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  // crypto.randomUUID is unavailable on insecure origins (plain-HTTP LAN testing).
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    return [...b].map((x, i) => ([4, 6, 8, 10].includes(i) ? '-' : '') + x.toString(16).padStart(2, '0')).join('');
  }

  function newPeerId() {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // no lookalikes, easier to type
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    let s = '';
    for (const b of bytes) s += alphabet[b % alphabet.length];
    return 'atp-' + s;
  }

  function getPeer(id) { return state.peers.find((p) => p.id === id); }
  function peerLabel(id) { const p = getPeer(id); return p ? p.label : (id ? id.slice(-4) : '—'); }

  async function savePeers() {
    await db.kvSet('peers', state.peers);
    await db.kvSet('activePeer', state.activePeer);
  }

  /* ---------- boot ---------- */

  async function init() {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data === 'outbox-updated') refreshLists().then(() => state.transfer && state.transfer.drain());
      });
    }

    state.role = await db.kvGet('role') || null;
    state.myId = await db.kvGet('myId');
    state.peers = await db.kvGet('peers') || [];
    state.activePeer = await db.kvGet('activePeer') || null;
    if (!state.myId) {
      state.myId = newPeerId();
      await db.kvSet('myId', state.myId);
    }

    // Migrate the old single-peer schema.
    const legacyPeer = await db.kvGet('peerId');
    if (legacyPeer && !getPeer(legacyPeer)) {
      state.peers.push({ id: legacyPeer, label: 'Device ' + legacyPeer.slice(-4), addedAt: Date.now() });
      state.activePeer = state.activePeer || legacyPeer;
      await savePeers();
      await db.kvDelete('peerId');
    }
    if (state.activePeer && !getPeer(state.activePeer)) state.activePeer = state.peers[0] ? state.peers[0].id : null;
    state.allowedIds = new Set(state.peers.map((p) => p.id));

    // Arriving via a scanned pairing QR (…#pair=<peer-id>) makes this device the tablet.
    const pairMatch = location.hash.match(/^#pair=(atp-[a-z0-9]+)$/);
    if (pairMatch) {
      state.role = state.role || 'tablet';
      await db.kvSet('role', state.role);
      history.replaceState(null, '', location.pathname + location.search);
      startApp();
      beginPairingWith(pairMatch[1]);
      return;
    }

    if (!state.role) return show('role-chooser');
    startApp();

    // Resume an interrupted pairing attempt (e.g. Android killed the PWA
    // before the other side confirmed).
    const pending = await db.kvGet('pendingPair');
    if (pending && !getPeer(pending)) beginPairingWith(pending);
    else if (pending) await db.kvDelete('pendingPair');
  }

  function show(id) {
    for (const panel of document.querySelectorAll('main > section')) panel.hidden = panel.id !== id;
    closePeerMenu();
  }

  function backToMain() {
    if (state.transfer) state.transfer.pairingOpen = false;
    if (state.peers.length === 0) return showPairingPanel();
    show(state.role === 'desktop' ? 'desktop-main' : 'tablet-main');
    updateStatusText();
    refreshLists();
  }

  /* ---------- status header ---------- */

  function setDot(cls) { $('#status-dot').className = 'dot ' + cls; }

  function updateStatusText() {
    if (state.connectedPeer) {
      setDot('ok');
      $('#status-text').textContent = 'Connected · ' + peerLabel(state.connectedPeer);
    } else if (state.activePeer) {
      setDot('wait');
      $('#status-text').textContent = 'Waiting for ' + peerLabel(state.activePeer) + '…';
    } else {
      setDot('wait');
      $('#status-text').textContent = 'Not paired';
    }
    renderPeerMenu();
  }

  /* ---------- shared transfer wiring ---------- */

  function createTransfer() {
    const transfer = new Transfer({
      myId: state.myId,
      allowedIds: state.allowedIds,
      targetId: state.activePeer,
      onStatus: (cls, text, peerId) => {
        state.connectedPeer = cls === 'connected' ? peerId : null;
        if (cls === 'error') { setDot('err'); $('#status-text').textContent = text; console.error('[atp]', text); }
        else updateStatusText();
      },
      onPairRequest: handlePairRequest,
      onPaired: handlePaired,
      onFileReceived: handleFileReceived,
      onProgress: (id, done, total, dir) => { state.progress.set(id, { done, total, dir }); renderProgress(id); },
      onAcked: async (id) => {
        state.progress.delete(id);
        await db.delete('outbox', id);
        refreshLists();
      },
      getOutbox: async (forPeerId) => {
        const all = await db.getAll('outbox');
        return all.filter((r) => !r.target || r.target === forPeerId);
      },
      persistIncoming: (record) => db.add('inbox', record),
    });
    return transfer;
  }

  function startApp() {
    state.transfer = createTransfer();
    state.transfer.start();
    wireUi();
    if (state.peers.length === 0) showPairingPanel();
    else backToMain();

    // Keepalive: ping every 30 s while the page is visible (tab active /
    // screen on); also detects dead connections and redials.
    setInterval(() => state.transfer.keepalive(!document.hidden), KEEPALIVE_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        state.transfer.keepalive(true);
        state.transfer.drain();
      }
    });
  }

  /* ---------- pairing ---------- */

  function showPairingPanel() {
    if (state.role === 'desktop') {
      state.transfer.pairingOpen = true;
      const url = location.origin + location.pathname + '#pair=' + state.myId;
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      $('#qr-holder').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2 });
      $('#pair-code-display').textContent = state.myId;
      $('#pair-url-display').textContent = url;
      $('#pair-back-d').hidden = state.peers.length === 0;
      show('desktop-pair');
    } else {
      $('#pair-back-t').hidden = state.peers.length === 0;
      $('#pair-code-error').textContent = '';
      show('tablet-pair');
    }
  }

  function beginPairingWith(code) {
    if (getPeer(code)) { setActivePeer(code); backToMain(); return; }
    if (state.peers.length >= MAX_PEERS) { alert(`Limit of ${MAX_PEERS} paired devices reached. Forget one first.`); return; }
    db.kvSet('pendingPair', code); // survives the app being killed mid-pairing
    $('#pairing-target').textContent = code;
    show('tablet-pairing-wait');
    state.transfer.pairWith(code);
  }

  function handlePairRequest(remoteId, accept) {
    // Receiving side's one-time confirmation (shown on whichever device displayed the QR).
    if (state.peers.length >= MAX_PEERS) { accept(false); return; }
    state.pendingAccept = accept; // hellos repeat every 4 s; always answer the latest
    if (!$('#trust-prompt').hidden && $('#trust-id').textContent === remoteId) return; // don't wipe the name being typed
    $('#trust-id').textContent = remoteId;
    $('#trust-name').value = '';
    $('#trust-prompt').hidden = false;
    $('#trust-yes').onclick = async () => {
      $('#trust-prompt').hidden = true;
      await addPeer(remoteId, $('#trust-name').value.trim());
      state.pendingAccept(true);
      backToMain();
    };
    $('#trust-no').onclick = () => { $('#trust-prompt').hidden = true; state.pendingAccept(false); };
  }

  async function handlePaired(remoteId) {
    await db.kvDelete('pendingPair');
    if (!getPeer(remoteId)) await addPeer(remoteId, '');
    backToMain();
  }

  async function addPeer(id, label) {
    state.peers.push({ id, label: label || 'Device ' + id.slice(-4), addedAt: Date.now() });
    state.allowedIds.add(id);
    state.activePeer = id;
    await savePeers();
    state.transfer.setTarget(id);
    updateStatusText();
  }

  async function setActivePeer(id) {
    state.activePeer = id;
    await savePeers();
    state.transfer.setTarget(id);
    updateStatusText();
    refreshLists();
  }

  async function forgetPeer(id) {
    if (!confirm(`Forget ${peerLabel(id)}? Files queued for it stay in the queue.`)) return;
    state.peers = state.peers.filter((p) => p.id !== id);
    state.allowedIds.delete(id);
    if (state.activePeer === id) state.activePeer = state.peers[0] ? state.peers[0].id : null;
    await savePeers();
    state.transfer.setTarget(state.activePeer);
    updateStatusText();
    refreshLists();
    if (state.peers.length === 0) showPairingPanel();
  }

  async function renamePeer(id) {
    const peer = getPeer(id);
    const label = prompt('Name this device:', peer.label);
    if (!label) return;
    peer.label = label.trim() || peer.label;
    await savePeers();
    updateStatusText();
    refreshLists();
  }

  /* ---------- peer menu (click the status in the header) ---------- */

  function closePeerMenu() { $('#peer-menu').hidden = true; }

  function renderPeerMenu() {
    const menu = $('#peer-menu');
    if (menu.hidden) return;
    const list = $('#peer-menu-list');
    list.innerHTML = '';
    for (const peer of state.peers) {
      const li = document.createElement('li');
      li.className = 'peer-row' + (peer.id === state.activePeer ? ' active' : '');

      const dot = document.createElement('span');
      dot.className = 'dot ' + (peer.id === state.connectedPeer ? 'ok' : 'wait');

      const name = document.createElement('button');
      name.className = 'peer-name';
      name.textContent = peer.label + (peer.id === state.activePeer ? ' ✓' : '');
      name.title = peer.id;
      name.addEventListener('click', () => { setActivePeer(peer.id); closePeerMenu(); });

      const rename = document.createElement('button');
      rename.className = 'ghost mini';
      rename.textContent = '✎';
      rename.title = 'Rename';
      rename.addEventListener('click', () => renamePeer(peer.id));

      const forget = document.createElement('button');
      forget.className = 'ghost mini';
      forget.textContent = '✕';
      forget.title = 'Forget this device';
      forget.addEventListener('click', () => forgetPeer(peer.id));

      li.append(dot, name, rename, forget);
      list.append(li);
    }
    const add = $('#add-device');
    add.disabled = state.peers.length >= MAX_PEERS;
    add.textContent = state.peers.length >= MAX_PEERS ? `Limit of ${MAX_PEERS} devices reached` : '＋ Add / re-pair device';
  }

  /* ---------- UI wiring (once) ---------- */

  let uiWired = false;
  function wireUi() {
    if (uiWired) return;
    uiWired = true;

    $('#status').addEventListener('click', () => {
      const menu = $('#peer-menu');
      menu.hidden = !menu.hidden;
      renderPeerMenu();
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#status') && !e.target.closest('#peer-menu')) closePeerMenu();
    });
    $('#add-device').addEventListener('click', () => { closePeerMenu(); showPairingPanel(); });
    $('#pair-back-d').addEventListener('click', backToMain);
    $('#pair-back-t').addEventListener('click', backToMain);
    $('#pair-cancel').addEventListener('click', async () => {
      await db.kvDelete('pendingPair');
      state.transfer.pendingPair = null;
      backToMain();
    });

    if (state.role === 'desktop') {
      const zone = $('#drop-zone');
      zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('over'));
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('over');
        enqueueFiles(e.dataTransfer.files);
      });
      $('#file-input').addEventListener('change', (e) => enqueueFiles(e.target.files));
      $('#choose-folder').addEventListener('click', chooseSaveFolder);
      $('#my-code').textContent = state.myId;
      updateFolderLabel();
    } else {
      $('#overlay-close').addEventListener('click', () => { $('#share-overlay').hidden = true; });
    }
  }

  /* ---------- role chooser ---------- */

  $('#choose-desktop').addEventListener('click', async () => {
    state.role = 'desktop';
    await db.kvSet('role', 'desktop');
    startApp();
  });

  $('#choose-tablet').addEventListener('click', async () => {
    state.role = 'tablet';
    await db.kvSet('role', 'tablet');
    startApp();
  });

  $('#pair-code-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#pair-code-input').value.trim().toLowerCase();
    if (!/^atp-[a-z0-9]+$/.test(code)) { $('#pair-code-error').textContent = 'That doesn’t look like a pairing code.'; return; }
    beginPairingWith(code);
  });

  /* ---------- desktop: sending & saving ---------- */

  async function enqueueFiles(fileList) {
    if (!state.activePeer) { alert('Pair a device first.'); return; }
    for (const file of fileList) {
      const mime = file.type || (file.name.toLowerCase().endsWith('.docx') ? DOCX_MIME : 'application/pdf');
      await db.add('outbox', {
        id: uuid(),
        name: file.name,
        mime,
        size: file.size,
        blob: file,
        target: state.activePeer,
        addedAt: Date.now(),
      });
    }
    await refreshLists();
    state.transfer.drain();
  }

  async function chooseSaveFolder() {
    if (!window.showDirectoryPicker) { alert('This browser doesn’t support choosing a folder; files will download instead.'); return; }
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      await db.kvSet('dir', handle);
      updateFolderLabel();
      trySaveAllPending();
    } catch (e) { /* user cancelled */ }
  }

  async function updateFolderLabel() {
    const handle = await db.kvGet('dir');
    $('#folder-label').textContent = handle ? `Saving returned files to: ${handle.name}` : 'No save folder chosen — returned files will download.';
  }

  async function saveToFolder(record) {
    const dir = await db.kvGet('dir');
    if (!dir) return false;
    let perm = await dir.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') perm = await dir.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return false;
    // Avoid clobbering: append (1), (2)… if the name already exists.
    let name = record.name;
    for (let i = 1; i < 100; i++) {
      try { await dir.getFileHandle(name); } catch { break; }
      const dot = record.name.lastIndexOf('.');
      name = dot > 0 ? `${record.name.slice(0, dot)} (${i})${record.name.slice(dot)}` : `${record.name} (${i})`;
    }
    const fileHandle = await dir.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(record.blob);
    await writable.close();
    return true;
  }

  async function trySaveAllPending() {
    for (const record of await db.getAll('inbox')) {
      if (!record.saved && await saveToFolder(record).catch(() => false)) {
        record.saved = true;
        await db.update('inbox', record);
      }
    }
    refreshLists();
  }

  /* ---------- tablet: opening files ---------- */

  async function openInApp(record) {
    const file = new File([record.blob], record.name, { type: record.mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: record.name });
      } catch (e) {
        // If the system does not allow sharing this file due to type restrictions (as with docx on Android), we force a local download and update the record state to notify the user in the UI.
        if (e.name !== 'AbortError') {
          downloadRecord(record);
          record.saved = true;
          record.downloaded = true;
          await db.update('inbox', record);
          refreshLists();
        }
      }
    } else {
      downloadRecord(record); // desktop browsers / no Web Share: plain download
      // Update the state to saved and downloaded so the user has visual confirmation in the file list.
      record.saved = true;
      record.downloaded = true;
      await db.update('inbox', record);
      refreshLists();
    }
  }

  function downloadRecord(record) {
    const url = URL.createObjectURL(record.blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = record.name;
    // In mobile browsers like Chrome on Android, the anchor element must be temporarily appended to the document's DOM for the programmatic click event to successfully trigger the download of a blob resource.
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function showShareOverlay(record) {
    $('#overlay-name').textContent = record.name;
    $('#overlay-open').onclick = () => { $('#share-overlay').hidden = true; openInApp(record); };
    // Allow direct download from the overlay to offer an immediate manual alternative if preferred.
    $('#overlay-download').onclick = async () => {
      $('#share-overlay').hidden = true;
      downloadRecord(record);
      record.saved = true;
      record.downloaded = true;
      await db.update('inbox', record);
      refreshLists();
    };
    $('#share-overlay').hidden = false;
  }

  /* ---------- receiving ---------- */

  async function handleFileReceived(record) {
    state.progress.delete(record.id);
    if (state.role === 'desktop') {
      // Save automatically: to the chosen folder if we can, otherwise a
      // regular browser download — no clicks needed either way.
      if (await saveToFolder(record).catch(() => false)) {
        record.saved = true;
      } else {
        downloadRecord(record);
        record.saved = true;
        record.downloaded = true;
      }
      await db.update('inbox', record);
    } else {
      // One tap on the popup opens the Android share card.
      showShareOverlay(record);
    }
    refreshLists();
  }

  /* ---------- rendering ---------- */

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  async function refreshLists() {
    const suffix = state.role === 'tablet' ? '-t' : '';
    if (!$('#outbox-list' + suffix)) return;
    const outbox = await db.getAll('outbox');
    const inbox = await db.getAll('inbox');
    renderList($('#outbox-list' + suffix), outbox, 'outbox');
    renderList($('#inbox-list' + suffix), inbox, 'inbox');
    $('#outbox-empty' + suffix).hidden = outbox.length > 0;
    $('#inbox-empty' + suffix).hidden = inbox.length > 0;
  }

  function renderList(root, records, kind) {
    if (!root) return;
    root.innerHTML = '';
    for (const record of records.sort((a, b) => (b.addedAt || b.receivedAt) - (a.addedAt || a.receivedAt))) {
      const li = document.createElement('li');
      li.dataset.id = record.id;

      const info = document.createElement('div');
      info.className = 'file-info';
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = record.name;
      const meta = document.createElement('span');
      meta.className = 'file-meta';
      const bits = [fmtSize(record.size)];
      if (kind === 'outbox') bits.push('queued → ' + peerLabel(record.target || null));
      else if (record.saved) bits.push(record.downloaded ? 'downloaded' : 'saved');
      meta.textContent = bits.join(' • ');
      info.append(name, meta);

      const actions = document.createElement('div');
      actions.className = 'file-actions';
      if (kind === 'inbox') {
        if (state.role === 'tablet') {
          actions.append(button('Open in…', 'primary', () => openInApp(record)));
          // Add an explicit download button on the tablet for when the Web Share API fails or is not preferred.
          actions.append(button('Download', 'ghost', async () => {
            downloadRecord(record);
            record.saved = true;
            record.downloaded = true;
            await db.update('inbox', record);
            refreshLists();
          }));
        } else if (!record.saved) {
          actions.append(button('Save', 'primary', async () => {
            if (!await saveToFolder(record).catch(() => false)) downloadRecord(record);
            record.saved = true;
            await db.update('inbox', record);
            refreshLists();
          }));
        }
        actions.append(button('✕', 'ghost', async () => { await db.delete('inbox', record.id); refreshLists(); }));
      } else {
        actions.append(button('✕', 'ghost', async () => { await db.delete('outbox', record.id); refreshLists(); }));
      }

      const bar = document.createElement('div');
      bar.className = 'progress';
      bar.innerHTML = '<div class="progress-fill"></div>';
      bar.hidden = true;

      li.append(info, actions, bar);
      root.append(li);
    }
    for (const id of state.progress.keys()) renderProgress(id);
  }

  function button(label, cls, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = cls;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderProgress(id) {
    const li = document.querySelector(`li[data-id="${id}"]`);
    const p = state.progress.get(id);
    if (!li || !p) return;
    const bar = li.querySelector('.progress');
    bar.hidden = false;
    bar.querySelector('.progress-fill').style.width = Math.round((p.done / p.total) * 100) + '%';
  }

  /* ---------- reset ---------- */

  async function resetPairing(e) {
    e.preventDefault();
    if (!confirm('Forget ALL paired devices and this device’s role? Queued files are kept.')) return;
    await db.kvDelete('role');
    await db.kvDelete('peers');
    await db.kvDelete('activePeer');
    location.reload();
  }
  $('#reset-link').addEventListener('click', resetPairing);
  $('#reset-link-t').addEventListener('click', resetPairing);

  init();
})();

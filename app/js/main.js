/* App bootstrap, pairing flow, and UI for both roles. */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const db = self.ATPDB;

  const state = {
    role: null,       // 'desktop' | 'tablet'
    myId: null,
    peerId: null,     // trusted peer, null until paired
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
    state.peerId = await db.kvGet('peerId') || null;
    if (!state.myId) {
      state.myId = newPeerId();
      await db.kvSet('myId', state.myId);
    }

    // Arriving via a scanned pairing QR (…#pair=<desktop-id>) makes this device the tablet.
    const pairMatch = location.hash.match(/^#pair=(atp-[a-z0-9]+)$/);
    if (pairMatch && !state.peerId) {
      state.role = 'tablet';
      await db.kvSet('role', 'tablet');
      history.replaceState(null, '', location.pathname + location.search);
      startTablet(pairMatch[1]);
      return;
    }

    if (!state.role) return show('role-chooser');
    if (state.role === 'desktop') startDesktop();
    else startTablet(state.peerId);
  }

  function show(id) {
    for (const panel of document.querySelectorAll('main > section')) panel.hidden = panel.id !== id;
  }

  function setStatus(cls, text) {
    $('#status-dot').className = 'dot ' + cls;
    $('#status-text').textContent = text;
  }

  /* ---------- role chooser ---------- */

  $('#choose-desktop').addEventListener('click', async () => {
    state.role = 'desktop';
    await db.kvSet('role', 'desktop');
    startDesktop();
  });

  $('#choose-tablet').addEventListener('click', () => show('tablet-pair'));

  $('#pair-code-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('#pair-code-input').value.trim().toLowerCase();
    if (!/^atp-[a-z0-9]+$/.test(code)) { $('#pair-code-error').textContent = 'That doesn’t look like a pairing code.'; return; }
    state.role = 'tablet';
    await db.kvSet('role', 'tablet');
    startTablet(code);
  });

  /* ---------- shared transfer wiring ---------- */

  function createTransfer(trustedId) {
    return new Transfer({
      myId: state.myId,
      trustedId,
      onStatus: (cls, text) => {
        setStatus(cls === 'connected' ? 'ok' : cls === 'error' ? 'err' : 'wait', text);
        if (cls === 'error') console.error('[atp]', text);
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
      getOutbox: () => db.getAll('outbox'),
      persistIncoming: (record) => db.add('inbox', record),
    });
  }

  /* ---------- desktop ---------- */

  async function startDesktop() {
    show(state.peerId ? 'desktop-main' : 'desktop-pair');
    state.transfer = createTransfer(state.peerId);
    state.transfer.start();

    if (!state.peerId) {
      const url = location.origin + location.pathname + '#pair=' + state.myId;
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      $('#qr-holder').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2 });
      $('#pair-code-display').textContent = state.myId;
      $('#pair-url-display').textContent = url;
    } else {
      initDesktopMain();
    }
  }

  function handlePairRequest(remoteId, accept) {
    // Desktop-side one-time confirmation.
    $('#trust-id').textContent = remoteId;
    $('#trust-prompt').hidden = false;
    $('#trust-yes').onclick = async () => {
      $('#trust-prompt').hidden = true;
      state.peerId = remoteId;
      await db.kvSet('peerId', remoteId);
      accept(true);
      show('desktop-main');
      initDesktopMain();
    };
    $('#trust-no').onclick = () => { $('#trust-prompt').hidden = true; accept(false); };
  }

  function initDesktopMain() {
    $('#my-code').textContent = state.myId;
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
    updateFolderLabel();
    refreshLists();
  }

  async function enqueueFiles(fileList) {
    for (const file of fileList) {
      const mime = file.type || (file.name.toLowerCase().endsWith('.docx') ? DOCX_MIME : 'application/pdf');
      await db.add('outbox', {
        id: uuid(),
        name: file.name,
        mime,
        size: file.size,
        blob: file,
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

  /* ---------- tablet ---------- */

  function startTablet(pairWithId) {
    if (state.peerId) {
      show('tablet-main');
      state.transfer = createTransfer(state.peerId);
      state.transfer.start();
      refreshLists();
      return;
    }
    // One-time pairing: connect to the desktop's ID and say hello.
    show('tablet-pairing-wait');
    $('#pairing-target').textContent = pairWithId;
    state.transfer = createTransfer(pairWithId);
    const oldAdopt = state.transfer.adoptConnection.bind(state.transfer);
    state.transfer.adoptConnection = (conn, isIncoming) => {
      oldAdopt(conn, isIncoming);
      conn.on('open', () => state.transfer.sendHello());
    };
    state.transfer.start();
  }

  async function handlePaired(remoteId) {
    if (state.peerId) return;
    state.peerId = remoteId;
    await db.kvSet('peerId', remoteId);
    show('tablet-main');
    refreshLists();
  }

  async function openInApp(record) {
    const file = new File([record.blob], record.name, { type: record.mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: record.name }); } catch (e) { /* cancelled */ }
    } else {
      downloadRecord(record); // desktop browsers / no Web Share: plain download
    }
  }

  function downloadRecord(record) {
    const url = URL.createObjectURL(record.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = record.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /* ---------- receiving ---------- */

  async function handleFileReceived(record) {
    state.progress.delete(record.id);
    if (state.role === 'desktop') {
      if (await saveToFolder(record).catch(() => false)) {
        record.saved = true;
        await db.update('inbox', record);
      }
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
      meta.textContent = fmtSize(record.size) + (kind === 'outbox' ? ' • queued' : record.saved ? ' • saved' : '');
      info.append(name, meta);

      const actions = document.createElement('div');
      actions.className = 'file-actions';
      if (kind === 'inbox') {
        if (state.role === 'tablet') {
          const openBtn = button('Open in…', 'primary', () => openInApp(record));
          actions.append(openBtn);
        } else if (!record.saved) {
          actions.append(button('Save', 'primary', async () => {
            if (await saveToFolder(record).catch(() => false)) {
              record.saved = true;
              await db.update('inbox', record);
            } else {
              downloadRecord(record);
              record.saved = true;
              await db.update('inbox', record);
            }
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
    if (!confirm('Forget pairing and role? Queued files are kept.')) return;
    await db.kvDelete('role');
    await db.kvDelete('peerId');
    location.reload();
  }
  $('#reset-link').addEventListener('click', resetPairing);
  $('#reset-link-t').addEventListener('click', resetPairing);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.transfer) state.transfer.drain();
  });

  init();
})();

/* IndexedDB layer shared by the page and the service worker.
   Stores:
     outbox — files queued for transfer to the peer
     inbox  — files received from the peer
     kv     — settings (role, myId, peerId, save-folder handle) */
(function (scope) {
  'use strict';

  const DB_NAME = 'atp';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('inbox')) db.createObjectStore('inbox', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function run(storeName, mode, work) {
    return open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let result;
      const req = work(store);
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  scope.ATPDB = {
    kvGet: (key) => run('kv', 'readonly', (s) => s.get(key)),
    kvSet: (key, value) => run('kv', 'readwrite', (s) => s.put(value, key)),
    kvDelete: (key) => run('kv', 'readwrite', (s) => s.delete(key)),

    add: (storeName, record) => run(storeName, 'readwrite', (s) => s.put(record)),
    get: (storeName, id) => run(storeName, 'readonly', (s) => s.get(id)),
    getAll: (storeName) => run(storeName, 'readonly', (s) => s.getAll()),
    delete: (storeName, id) => run(storeName, 'readwrite', (s) => s.delete(id)),
    update: (storeName, record) => run(storeName, 'readwrite', (s) => s.put(record)),
  };
})(self);

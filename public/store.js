/**
 * Offline-first persistence with IndexedDB.
 *  - "docs":   the last known CRDT document per board (instant render on reload, works offline)
 *  - "outbox": operations not yet acknowledged by the server (replayed on reconnect)
 * Falls back to memory if IndexedDB is unavailable (e.g. private mode).
 */
(function () {
  const mem = { docs: new Map(), outbox: new Map() };
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve) => {
      try {
        const req = indexedDB.open('liveboard', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          db.createObjectStore('docs');
          db.createObjectStore('outbox', { keyPath: 'op.id' }).createIndex('board', 'board');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
    return dbp;
  }
  const tx = async (store, mode, fn) => {
    const db = await open();
    if (!db) return fn(null);
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode), s = t.objectStore(store);
      let out; const r = fn(s);
      if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => resolve(out); t.onerror = () => reject(t.error);
    });
  };
  window.LocalStore = {
    async loadDoc(board) { return (await tx('docs', 'readonly', s => s ? s.get(board) : null)) || mem.docs.get(board) || null; },
    async saveDoc(board, doc) { mem.docs.set(board, doc); await tx('docs', 'readwrite', s => s && s.put(doc, board)); },
    async enqueue(board, op) { mem.outbox.set(op.id, { board, op }); await tx('outbox', 'readwrite', s => s && s.put({ board, op })); },
    async dequeue(id) { mem.outbox.delete(id); await tx('outbox', 'readwrite', s => s && s.delete(id)); },
    async pending(board) {
      const rows = await tx('outbox', 'readonly', s => s ? s.index('board').getAll(board) : null);
      const list = rows || [...mem.outbox.values()].filter(r => r.board === board);
      return list.map(r => r.op).sort((a, b) => (a.ts < b.ts ? -1 : 1));
    },
  };
})();

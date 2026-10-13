// Tiny IndexedDB wrapper – keeps drafts, unsent orders and photos on the phone (works offline).
const DB = (() => {
  const STORES = ['kv', 'outbox', 'photos', 'pocache'];
  let dbp;
  function open() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('mechery-po', 1);
      r.onupgradeneeded = () => STORES.forEach(s => { if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode), s = t.objectStore(store);
      let out; const r = fn(s);
      if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('Storage full or blocked'));
    });
  }
  return {
    get: (store, k) => tx(store, 'readonly', s => s.get(k)),
    set: (store, k, v) => tx(store, 'readwrite', s => s.put(v, k)),
    del: (store, k) => tx(store, 'readwrite', s => s.delete(k)),
    all: (store) => tx(store, 'readonly', s => s.getAll()),
    keys: (store) => tx(store, 'readonly', s => s.getAllKeys()),
    clear: (store) => tx(store, 'readwrite', s => s.clear()),
    async persist() { try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) {} return false; }
  };
})();

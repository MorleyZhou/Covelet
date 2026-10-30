// One-way migration only: old records remain intact until their encrypted
// replacements have been read back and compared, including every Blob byte.
const migrations = new Map();
const signature = (value) => JSON.stringify(value, (_, item) => item instanceof Blob
  ? { $blob: true, type: item.type, size: item.size } : item);
async function fingerprint(value) {
  if (value instanceof Blob) return ['blob', value.type, value.size, [...new Uint8Array(await crypto.subtle.digest('SHA-256', await value.arrayBuffer()))]];
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    return ['bytes', [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]];
  }
  if (Array.isArray(value)) return Promise.all(value.map(fingerprint));
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = await fingerprint(value[key]);
    return result;
  }
  return value;
}
async function openExisting(name, store) {
  if (!globalThis.indexedDB) return null;
  if (indexedDB.databases && !(await indexedDB.databases()).some((item) => item.name === name)) return null;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    let absent = false, blocked = false;
    request.onupgradeneeded = () => { absent = true; request.transaction.abort(); };
    request.onerror = () => absent ? resolve(null) : reject(request.error);
    request.onblocked = () => { blocked = true; reject(Error('Legacy image database is blocked.')); };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      if (!db.objectStoreNames.contains(store)) { db.close(); resolve(null); }
      else if (db.version >= 2) resolve(db);
      else {
        // All legacy writers open version 1. Raising the version fences them
        // out before comparing/copying Blob bytes, so an old page cannot
        // replace same-sized pixels between verification and cleanup.
        db.close();
        const upgrade = indexedDB.open(name, 2);
        upgrade.onerror = () => reject(upgrade.error);
        upgrade.onblocked = () => { blocked = true; reject(Error('Close older Covelet pages and retry local data migration.')); };
        upgrade.onsuccess = () => { if (blocked) upgrade.result.close(); else resolve(upgrade.result); };
      }
    };
  });
}
export function migrateLegacyIndexedDb(database, store, target, keyOf = (_, key) => key) {
  const scope = `${database}:${store}`;
  if (migrations.has(scope)) return migrations.get(scope);
  const migrate = async () => {
    const db = await openExisting(database, store);
    if (!db) return;
    try {
      const records = await new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly'), objectStore = tx.objectStore(store);
        const values = objectStore.getAll(), keys = objectStore.getAllKeys();
        tx.oncomplete = () => resolve(values.result.map((value, index) => [keys.result[index], value]));
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
      for (const [oldKey, value] of records) {
        const key = String(keyOf(value, oldKey)), expected = JSON.stringify(await fingerprint(value));
        const existing = await target.get(key);
        if (existing !== undefined && existing !== null && JSON.stringify(await fingerprint(existing)) !== expected) {
          // Never overwrite either copy when a previous migration or an old
          // open page has produced a different record under the same key.
          throw Error('Local image migration found conflicting copies; original data was preserved.');
        }
        if (existing === undefined || existing === null) await target.set(key, value);
        if (JSON.stringify(await fingerprint(await target.get(key))) !== expected) throw Error('Encrypted image migration verification failed.');
        await new Promise((resolve, reject) => {
          const tx = db.transaction(store, 'readwrite'), objectStore = tx.objectStore(store), read = objectStore.get(oldKey);
          read.onsuccess = () => {
            if (signature(read.result) !== signature(value)) { tx.abort(); return; }
            objectStore.delete(oldKey);
          };
          tx.oncomplete = resolve;
          tx.onerror = tx.onabort = () => reject(tx.error || Error('Legacy image changed during migration; original data was preserved.'));
        });
      }
    } finally { db.close(); }
  };
  const work = (globalThis.navigator?.locks?.request ? navigator.locks.request(`covelet.migrate:${scope}`, migrate) : migrate())
    .catch((error) => { migrations.delete(scope); throw error; });
  migrations.set(scope, work);
  return work;
}

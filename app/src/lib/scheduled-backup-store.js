// Native structured cloning is required for FileSystemDirectoryHandle and a
// nonextractable CryptoKey. This device-only DB is outside portable content.
const DATABASE = 'covelet.scheduled-backup.v1', STORE = 'schedule', KEY = 'state';
const failure = () => Object.assign(Error('Could not persist the scheduled backup configuration.'), { code: 'SCHEDULED_BACKUP_STORAGE' });

export function createScheduledBackupStore({ indexedDB = globalThis.indexedDB, databaseName = DATABASE } = {}) {
  let opening;
  async function open() {
    if (!indexedDB?.open) throw failure();
    if (!opening) opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1); let rejected = false;
      request.onupgradeneeded = () => {
        if (rejected) { request.transaction.abort(); return; }
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onerror = request.onblocked = () => { rejected = true; reject(failure()); };
      request.onsuccess = () => {
        if (rejected) { request.result.close(); return; }
        const db = request.result;
        db.onversionchange = () => { db.close(); opening = undefined; };
        resolve(db);
      };
    }).catch((error) => { opening = undefined; throw error; });
    return opening;
  }
  async function transaction(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode); let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(failure());
      try { action(tx.objectStore(STORE), (value) => { result = value; }); }
      catch { try { tx.abort(); } catch { /* Already aborted. */ } reject(failure()); }
    });
  }
  return {
    read: () => transaction('readonly', (store, result) => { store.get(KEY).onsuccess = (event) => result(event.target.result || null); }),
    write: (value) => transaction('readwrite', (store) => { store.put(value, KEY); }),
    async close() { if (opening) (await opening).close(); opening = undefined; },
  };
}

export const scheduledBackupStore = createScheduledBackupStore();

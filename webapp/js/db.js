// IndexedDB storage. Everything stays on the phone.
const DB_NAME = 'golftracker';
const DB_VERSION = 2;
// Stores in a backup. The tracker's capture log (training data, a few MB) has
// its own export on the Training data screen instead.
export const STORES = ['courses', 'rounds', 'shots', 'settings'];

let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('courses')) db.createObjectStore('courses', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('rounds')) {
        const s = db.createObjectStore('rounds', { keyPath: 'id' });
        s.createIndex('courseId', 'courseId');
      }
      if (!db.objectStoreNames.contains('shots')) {
        const s = db.createObjectStore('shots', { keyPath: 'id' });
        s.createIndex('roundId', 'roundId');
      }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('captures')) {
        const s = db.createObjectStore('captures', { keyPath: 'id' });   // `${logId}-${seq}`
        s.createIndex('logId', 'logId');
      }
    };
    req.onsuccess = () => {
      // Let a newer version of the app (another tab) upgrade the database.
      req.result.onversionchange = () => { req.result.close(); dbp = null; };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result;
    Promise.resolve(fn(t)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const req2p = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export const uid = () =>
  (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

export const get = (store, id) => tx(store, 'readonly', (t) => req2p(t.objectStore(store).get(id)));
export const all = (store) => tx(store, 'readonly', (t) => req2p(t.objectStore(store).getAll()));
export const put = (store, value) => tx(store, 'readwrite', (t) => req2p(t.objectStore(store).put(value)));
export const del = (store, id) => tx(store, 'readwrite', (t) => req2p(t.objectStore(store).delete(id)));
export const byIndex = (store, index, key) =>
  tx(store, 'readonly', (t) => req2p(t.objectStore(store).index(index).getAll(key)));

export const shotsForRound = (roundId) => byIndex('shots', 'roundId', roundId);
export const capturesForLog = (logId) => byIndex('captures', 'logId', logId);

export async function deleteRound(roundId) {
  const shots = await shotsForRound(roundId);
  await tx(['rounds', 'shots'], 'readwrite', (t) => {
    t.objectStore('rounds').delete(roundId);
    for (const s of shots) t.objectStore('shots').delete(s.id);
  });
}

export async function getSetting(key, fallback) {
  const r = await get('settings', key);
  return r ? r.value : fallback;
}
export const setSetting = (key, value) => put('settings', { key, value });

// Full backup as one JSON object.
export async function exportAll() {
  const out = { app: 'golftracker', version: 1, exportedAt: new Date().toISOString() };
  for (const s of STORES) out[s] = await all(s);
  out.settings = out.settings.filter((r) => r.key !== 'gcaKey'); // API keys stay on the phone
  return out;
}

// Import merges by id: records in the file replace records with the same id,
// nothing else is deleted, so importing an old backup never loses a newer round.
export async function importAll(data) {
  if (!data || data.app !== 'golftracker') throw new Error('This file is not a Golf Tracker backup.');
  const counts = {};
  await tx(STORES, 'readwrite', (t) => {
    for (const s of STORES) {
      const rows = Array.isArray(data[s]) ? data[s] : [];
      counts[s] = rows.length;
      for (const r of rows) t.objectStore(s).put(r);
    }
  });
  return counts;
}

// Ask Safari not to evict our data under storage pressure.
export async function requestPersistence() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}

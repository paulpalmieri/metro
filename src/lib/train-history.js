const DATABASE = "paris-metro-history";
const STORE = "snapshots";
const MAX_SNAPSHOTS = 48;
const MAX_AGE = 6 * 60 * 60 * 1000;

function openDatabase() {
  if (!("indexedDB" in globalThis)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: "updatedAt" });
      store.createIndex("capturedAt", "capturedAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadRecentSnapshots(limit = 24) {
  try {
    const database = await openDatabase();
    if (!database) return [];
    const records = await new Promise((resolve, reject) => {
      const request = database.transaction(STORE).objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const cutoff = Date.now() - MAX_AGE;
    return records
      .filter((snapshot) => snapshot.capturedAt >= cutoff)
      .sort((a, b) => b.capturedAt - a.capturedAt)
      .slice(0, limit);
  } catch {
    return [];
  }
}

export async function saveSnapshot(snapshot) {
  if (!snapshot?.updatedAt) return;
  try {
    const database = await openDatabase();
    if (!database) return;
    const transaction = database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    store.put({ ...snapshot, capturedAt: Date.now() });

    const allRequest = store.getAll();
    allRequest.onsuccess = () => {
      const cutoff = Date.now() - MAX_AGE;
      const records = allRequest.result.sort((a, b) => b.capturedAt - a.capturedAt);
      records.forEach((record, index) => {
        if (index >= MAX_SNAPSHOTS || record.capturedAt < cutoff) store.delete(record.updatedAt);
      });
    };
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  } catch {
    // Snapshot history is a progressive enhancement. Private browsing modes
    // and storage policies must never prevent the live map from working.
  }
}

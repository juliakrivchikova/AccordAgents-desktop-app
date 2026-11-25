import { META_STORE, OUTBOX_STORE } from "../base/storageKeys.js";

export function openDb() {
  // One description of this database, shared with the service worker. They
  // are separate programs over the same storage, and when each carried its
  // own version the two drifted far enough that the worker could no longer
  // open it at all.
  const schema = globalThis.AccordMobileDb;
  if (!schema) return Promise.reject(new Error("The phone's database description did not load."));
  return schema.openControlDb(indexedDB);
}

/**
 * One IndexedDB transaction across several stores: what an old pairing
 * kept goes all at once, and so does what the old queue became.
 */
export function eventLogPort() {
  return {
    runAtomic: function (names, work) {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          const tx = db.transaction(names, "readwrite");
          const stores = {};
          names.forEach(function (name) { stores[name] = tx.objectStore(name); });
          let value;
          let failed;
          tx.onerror = function () { reject(failed || tx.error || new Error("Event log transaction failed.")); };
          tx.onabort = function () { reject(failed || tx.error || new Error("Event log transaction aborted.")); };
          tx.oncomplete = function () { resolve(value); db.close(); };
          const handle = {
            get: function (name, key) { return requestToPromise(stores[name].get(key)); },
            getAll: function (name) { return requestToPromise(stores[name].getAll()); },
            put: function (name, entry) { return requestToPromise(stores[name].put(entry)); },
            remove: function (name, key) { return requestToPromise(stores[name].delete(key)); },
            clear: function (name) { return requestToPromise(stores[name].clear()); },
            removeWhere: function (name, matches) {
              return new Promise(function (resolve, reject) {
                const request = stores[name].openCursor();
                request.onerror = () => reject(request.error);
                request.onsuccess = function () {
                  const cursor = request.result;
                  if (!cursor) { resolve(); return; }
                  if (matches(cursor.value)) cursor.delete();
                  cursor.continue();
                };
              });
            }
          };
          Promise.resolve()
            .then(function () { return work(handle); })
            .then(function (result) { value = result; })
            .catch(function (error) { failed = error; try { tx.abort(); } catch (abortError) { reject(error); } });
        });
      });
    }
  };
}

export function withOutbox(mode, fn) {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(OUTBOX_STORE, mode);
      const store = tx.objectStore(OUTBOX_STORE);
      let value;
      tx.onerror = function () {
        reject(tx.error || new Error("Outbox transaction failed."));
      };
      tx.oncomplete = function () {
        resolve(value);
        db.close();
      };
      try {
        value = fn(store);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  });
}

export function requestToPromise(request) {
  return new Promise(function (resolve, reject) {
    request.onerror = function () {
      reject(request.error || new Error("IndexedDB request failed."));
    };
    request.onsuccess = function () {
      resolve(request.result);
    };
  });
}

export function withNamedStore(storeName, mode, fn) {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let value;
      tx.onerror = function () {
        reject(tx.error || new Error(storeName + " transaction failed."));
      };
      tx.oncomplete = function () {
        resolve(value);
        db.close();
      };
      try {
        value = fn(store);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  });
}

export async function readMetaRecord(key) {
  return withNamedStore(META_STORE, "readonly", function (store) {
    return requestToPromise(store.get(key));
  });
}

/**
 * A record this phone cannot lose quietly.
 *
 * This used to swallow its errors. A failed write of the signing identity
 * meant a phone that minted a new key on the next reload, which the server
 * then refused because its roster names the old one. It is visible now, and
 * the caller decides.
 */
export async function writeMetaRecord(key, value) {
  const existing = (await readMetaRecord(key)) || {};
  await withNamedStore(META_STORE, "readwrite", function (store) {
    store.put({ ...existing, ...value, key });
  });
}

/**
 * Replaces a record as a whole, in one transaction, while `still` holds for
 * what is there now. writeMetaRecord merges into the stored record, which
 * keeps every field the new value leaves out: a key written over a key kept
 * as text would keep the text beside it.
 */
export function replaceMetaRecordIf(key, value, still) {
  return withNamedStore(META_STORE, "readwrite", function (store) {
    const read = store.get(key);
    read.onsuccess = function () {
      if (still(read.result)) store.put({ ...value, key });
    };
  });
}

export function replaceMetaRecord(key, value) {
  return replaceMetaRecordIf(key, value, function () { return true; });
}

export function loadStoredStringArray(key) {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(function (value) {
      return typeof value === "string";
    }) : [];
  } catch {
    return [];
  }
}

export function saveStoredStringArray(key, values) {
  try {
    localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // Bookkeeping is best-effort; ingest stays idempotent without it.
  }
}

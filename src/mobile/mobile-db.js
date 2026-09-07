/**
 * The one description of this phone's database, for both contexts that open it.
 *
 * The page and the service worker are separate programs over the same
 * IndexedDB. They each used to carry their own copy of the version number and
 * the store list, and they drifted: the page moved to version 4 while the
 * worker still asked for 3. IndexedDB refuses to open a database at a version
 * lower than the one on disk, so from that moment every push-woken sync failed
 * before it read a single byte -- silently, because a push handler has nobody
 * to tell.
 *
 * So there is one version and one upgrade here, and both load it. A store
 * added for the page exists for the worker too, and neither can move without
 * the other.
 *
 * The upgrade only ever adds. A store this build does not know about is left
 * alone, because the other context may be a build ahead.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AccordMobileDb = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const DB_NAME = "accordagents-mobile-control";
  // Raise this only together with a store added in upgradeControlDb.
  const DB_VERSION = 5;

  const STORES = {
    outbox: "outbox",
    timeline: "timeline",
    meta: "meta",
    sealed: "sealedEnvelopes",
    events: "events",
    machineEvents: "machineEvents",
    machineOutbox: "machineOutbox",
    machineBlobs: "machineBlobs"
  };

  function upgradeControlDb(db) {
    if (!db.objectStoreNames.contains(STORES.outbox)) {
      const store = db.createObjectStore(STORES.outbox, { keyPath: "eventId" });
      store.createIndex("status", "status", { unique: false });
      store.createIndex("createdAt", "createdAt", { unique: false });
    }
    if (!db.objectStoreNames.contains(STORES.timeline)) {
      const store = db.createObjectStore(STORES.timeline, { keyPath: "id" });
      store.createIndex("createdAt", "createdAt", { unique: false });
    }
    if (!db.objectStoreNames.contains(STORES.meta)) {
      db.createObjectStore(STORES.meta, { keyPath: "key" });
    }
    if (!db.objectStoreNames.contains(STORES.sealed)) {
      db.createObjectStore(STORES.sealed, { keyPath: "eventId" });
    }
    if (!db.objectStoreNames.contains(STORES.events)) {
      const store = db.createObjectStore(STORES.events, { keyPath: "eventId" });
      store.createIndex("origin", ["originId", "logScopeId", "originSeq"], { unique: false });
      store.createIndex("conversationId", "conversationId", { unique: false });
    }
    // The phone's journal towards the machines it may command, and the bodies
    // too large to travel inside one event.
    if (!db.objectStoreNames.contains(STORES.machineEvents)) {
      const store = db.createObjectStore(STORES.machineEvents, { keyPath: "eventId" });
      store.createIndex("origin", ["originId", "logScopeId", "originSeq"], { unique: false });
    }
    if (!db.objectStoreNames.contains(STORES.machineOutbox)) {
      db.createObjectStore(STORES.machineOutbox, { keyPath: "eventId" });
    }
    if (!db.objectStoreNames.contains(STORES.machineBlobs)) {
      db.createObjectStore(STORES.machineBlobs, { keyPath: "key" });
    }
  }

  function hasStores(db, names) {
    return (names || []).every(function (name) { return db.objectStoreNames.contains(name); });
  }

  function request(open) {
    return new Promise(function (resolve, reject) {
      open.onupgradeneeded = function () { upgradeControlDb(open.result); };
      open.onsuccess = function () { resolve(open.result); };
      open.onerror = function () { reject(open.error || new Error("IndexedDB open failed.")); };
      open.onblocked = function () {
        reject(new Error("Another tab is holding this phone's database at an older version."));
      };
    });
  }

  /**
   * Opens the database without ever asking for a version older than the one on
   * disk.
   *
   * A build that is behind the other context still gets a usable handle: it
   * opens whatever is there and uses it if the stores it needs exist. It only
   * forces its own version when something it needs is genuinely missing, and
   * then never below the version already on disk -- so the two contexts cannot
   * lock each other out whichever of them updates first.
   */
  // What the last successful open settled on, so the ordinary case is one
  // open and not two. Per context, because each has its own module instance.
  let resolvedVersion;

  async function openControlDb(indexedDb, needed) {
    if (resolvedVersion) {
      try {
        return await request(indexedDb.open(DB_NAME, resolvedVersion));
      } catch (error) {
        // The other context upgraded underneath this one: a worker that
        // updated mid-session. Settle on the new version rather than failing
        // every read from here on.
        if (!error || error.name !== "VersionError") throw error;
        resolvedVersion = undefined;
      }
    }
    const existing = await request(indexedDb.open(DB_NAME));
    const wanted = needed || Object.values(STORES);
    if (existing.version >= DB_VERSION && hasStores(existing, wanted)) {
      resolvedVersion = existing.version;
      return existing;
    }
    // Never below what is already on disk: asking for an older version is the
    // error that broke the push path, and it would break the other context now.
    const version = Math.max(DB_VERSION, existing.version + (existing.version >= DB_VERSION ? 1 : 0));
    existing.close();
    const upgraded = await request(indexedDb.open(DB_NAME, version));
    resolvedVersion = upgraded.version;
    return upgraded;
  }

  return {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    STORES: STORES,
    upgradeControlDb: upgradeControlDb,
    hasStores: hasStores,
    openControlDb: openControlDb,
    /** Test seam: forget what the last open settled on. */
    resetResolvedVersion: function () { resolvedVersion = undefined; }
  };
});

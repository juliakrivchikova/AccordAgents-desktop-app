import { outboxStatusById } from "../base/storageKeys.js";
import { requestToPromise, withOutbox } from "../store/database.js";

export function noteOutboxStatus(entry) {
  if (entry && typeof entry.eventId === "string") {
    outboxStatusById.set(entry.eventId, {
      status: entry.status,
      ...(entry.lastError ? { lastError: entry.lastError } : {}),
      ...(entry.failedAt ? { failedAt: entry.failedAt } : {})
    });
  }
}

export function putOutboxEntry(entry) {
  noteOutboxStatus(entry);
  return withOutbox("readwrite", function (store) {
    return requestToPromise(store.put(entry));
  });
}

/** Several entries in one transaction: all of them, or none. */
export function putOutboxEntries(entries) {
  return withOutbox("readwrite", function (store) {
    return Promise.all(entries.map(function (entry) { return requestToPromise(store.put(entry)); }));
  }).then(function () {
    for (const entry of entries) noteOutboxStatus(entry);
  });
}

/** Changes one entry as it stands in the store now, in one transaction:
 *  `change` gets the stored entry and returns the new one, or undefined to
 *  leave it (answered or replaced meanwhile, by another flush or a second
 *  answer to the same card). Resolves with what was written. */
export function updateOutboxEntry(eventId, change) {
  let written;
  return withOutbox("readwrite", function (store) {
    return requestToPromise(store.get(eventId)).then(function (stored) {
      if (!stored) return undefined;
      const next = change(stored);
      if (!next) return undefined;
      written = next;
      return requestToPromise(store.put(next));
    });
  }).then(function () {
    if (written) noteOutboxStatus(written);
    return written;
  });
}

export function listOutboxEntries(conversationId) {
  return withOutbox("readonly", function (store) {
    return requestToPromise(store.getAll());
  }).then(function (entries) {
    for (const entry of entries) noteOutboxStatus(entry);
    return entries.filter(function (entry) {
      return !conversationId || entry.conversationId === conversationId;
    }).sort(function (left, right) {
      return left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId);
    });
  });
}

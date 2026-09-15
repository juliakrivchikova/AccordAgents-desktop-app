import type { ArtifactServiceDeps } from "./artifacts";
import type { ArtifactStore } from "./artifactStore";
import type { ChatActionArtifactPort } from "./chatActionApplier";
import type { ChatEventLogService } from "./chatEventLog";
import type { StorageService } from "./storage";
import { CHAT_ACTION_LOG_SCOPE } from "../../shared/chatActionEvents";
import type { DeviceEventRecipient } from "../../shared/deviceEventDelivery";
import { artifactStateChange, artifactStateEventSql } from "./artifactStateEvents";

/** The desktop and the headless runtime must install the same outgoing path.
 * Bodies are made durable before the signed event; the event and its recipient
 * rows commit with the local change, even when every recipient is offline. */
export function artifactEventWriter(
  storage: StorageService,
  log: ChatEventLogService,
  recipients: () => DeviceEventRecipient[],
  store: ArtifactStore
): Required<Pick<ArtifactServiceDeps, "emitAction" | "hasEmittedAction" | "commitActionWithChange" | "reemitAction">> {
  return {
    reemitAction: async (eventId) => {
      const event = await storage.getChatEvent(eventId);
      if (!event) return false;
      await storage.appendChatEvent(event, { recipients: recipients() });
      return true;
    },
    hasEmittedAction: async (eventId) => Boolean(await storage.getChatEvent(eventId)),
    emitAction: async (action) => {
      await store.init();
      await log.appendLocalEvent({
        ...action, logScopeId: CHAT_ACTION_LOG_SCOPE,
        payload: await storage.deviceEventBlobs().prepare(action.payload),
        eventId: `chat-action:${action.payload.operationId}`, recipients: recipients()
      });
    },
    commitActionWithChange: async (action, write) => {
      await store.init();
      const audience = recipients();
      const change = artifactStateChange(action.payload);
      const outcome = await log.withPreparedLocalEvent({
        ...action, logScopeId: CHAT_ACTION_LOG_SCOPE,
        payload: await storage.deviceEventBlobs().prepare(action.payload),
        eventId: `chat-action:${action.payload.operationId}`, recipients: audience
      }, (prepared) => write({
        sql: prepared.sql + (change ? artifactStateEventSql({ ...prepared.event, payload: action.payload }, change) : ""),
        onlyIfSql: (condition) => prepared.sql
          ? storage.chatEventAppendSql(prepared.event, { recipients: audience }, condition)
            + (change ? artifactStateEventSql({ ...prepared.event, payload: action.payload }, change, condition) : "") : ""
      }));
      return outcome.result;
    }
  };
}

/** Applying a remote change must also invalidate the visible artifact panel.
 * This is shared with the headless runtime, whose notification is a no-op. */
export function artifactProjectionPort(store: ArtifactStore, changed: (conversationId: string) => void): ChatActionArtifactPort {
  const notify = async (artifactId: string) => {
    const record = await store.getById(artifactId);
    if (record) changed(record.conversationId);
  };
  return {
    applyState: async (event, payload) => {
      const result = await store.withMutation(event.conversationId, () => store.applyStateEvent(event, payload));
      changed(event.conversationId);
      return result;
    },
    getRevision: (artifactId, versionEventId) => store.getRevision(artifactId, versionEventId),
    hasArtifact: async (artifactId) => Boolean(await store.getById(artifactId)),
    insertSignature: async (record) => {
      const inserted = await store.insertSignature(record, undefined, undefined, true);
      if (inserted) await notify(record.artifactId);
      return inserted;
    },
    createArtifact: async (request) => {
      if (!request.publication) throw new Error("The initial artifact event must contain its publication.");
      await store.withMutation(request.conversationId, () => store.applyPublication(request.artifactId, request.publication!, request.revision.versionEventId, request.conversationId));
      await notify(request.artifactId);
    },
    publishArtifact: async (request) => {
      await store.withMutation(request.conversationId, () => store.applyPublication(request.artifactId, request.body, request.versionEventId, request.conversationId));
      await notify(request.artifactId);
    },
    retainRevision: async (request) => {
      await store.retainProjectedRevision({ ...request, contentHash: "" });
      await notify(request.artifactId);
    }
  };
}

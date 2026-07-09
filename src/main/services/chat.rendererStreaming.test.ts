import assert from "node:assert/strict";
import test from "node:test";

import {
  remoteRunStreamingActivityEvents,
  remoteRunStreamingContent,
  remoteRunStreamingStartedAt
} from "../../shared/remoteRunStreaming";
import type { ChatAgentActivityEvent, ChatRemoteRunStatus } from "../../shared/types";

const PERSISTED_ACTIVITY: ChatAgentActivityEvent = {
  id: "remote:activity:1",
  sequence: 1,
  kind: "tool",
  label: "Running command",
  createdAt: "2026-07-04T16:00:05.000Z"
};

test("remote pending message streams persisted content when live progress has no partial content", () => {
  assert.equal(remoteRunStreamingContent({
    isStreaming: true,
    appMessageSource: "remote-run-provider-output",
    displayContent: "Remote streamed text."
  }), "Remote streamed text.");
});

test("local pending message does not fall back to persisted content", () => {
  assert.equal(remoteRunStreamingContent({
    isStreaming: true,
    displayContent: "Hidden until local live partial arrives."
  }), undefined);
});

test("live partial content wins over persisted remote content", () => {
  assert.equal(remoteRunStreamingContent({
    isStreaming: true,
    appMessageSource: "remote-run-provider-output",
    livePartialContent: "Live partial.",
    displayContent: "Persisted remote text."
  }), "Live partial.");
});

test("remote pending message falls back to persisted activity events", () => {
  assert.deepEqual(remoteRunStreamingActivityEvents({
    isStreaming: true,
    appMessageSource: "remote-run-provider-output",
    persistedActivityEvents: [PERSISTED_ACTIVITY]
  }), [PERSISTED_ACTIVITY]);
});

test("live activity events win over persisted remote activity", () => {
  assert.deepEqual(remoteRunStreamingActivityEvents({
    isStreaming: true,
    appMessageSource: "remote-run-provider-output",
    liveActivityEvents: [],
    persistedActivityEvents: [PERSISTED_ACTIVITY]
  }), []);
});

test("local pending message never falls back to persisted activity", () => {
  assert.deepEqual(remoteRunStreamingActivityEvents({
    isStreaming: true,
    persistedActivityEvents: [PERSISTED_ACTIVITY]
  }), []);
});

test("remote streaming timer uses processing start for active processing phase", () => {
  const status: ChatRemoteRunStatus = {
    phase: "processing-request",
    label: "Processing request",
    startedAt: "2026-07-04T16:00:00.000Z",
    updatedAt: "2026-07-04T16:00:10.000Z",
    processingStartedAt: "2026-07-04T16:00:08.000Z"
  };

  assert.equal(
    remoteRunStreamingStartedAt("2026-07-04T15:59:00.000Z", status),
    "2026-07-04T16:00:08.000Z"
  );
});

test("remote streaming timer uses phase start during setup and waiting phases", () => {
  const status: ChatRemoteRunStatus = {
    phase: "syncing-files",
    label: "Syncing project files",
    startedAt: "2026-07-04T16:00:00.000Z",
    updatedAt: "2026-07-04T16:00:10.000Z"
  };

  assert.equal(
    remoteRunStreamingStartedAt("2026-07-04T15:59:00.000Z", status),
    "2026-07-04T16:00:00.000Z"
  );
});

import { TERMINAL_RUNS_KEY } from "../base/storageKeys.js";
import { loadStoredStringArray, saveStoredStringArray } from "./database.js";

const TERMINAL_RUNS_MAX = 600;

// Once a run has produced its final (done or error) event, replayed copies
// of its older "running" placeholders must not resurrect. A retry of the
// same run stays visible because its placeholder is newer than the recorded
// terminal timestamp.
let terminalRunMap;

function terminalRuns() {
  if (!terminalRunMap) {
    terminalRunMap = new Map();
    for (const pair of loadStoredStringArray(TERMINAL_RUNS_KEY)) {
      const split = pair.indexOf("\u0000");
      if (split > 0) {
        terminalRunMap.set(pair.slice(0, split), pair.slice(split + 1));
      }
    }
  }
  return terminalRunMap;
}

function terminalRunKeys(runId, mobileEventId) {
  const keys = [];
  if (typeof runId === "string" && runId.trim()) {
    keys.push("run\u0000" + runId.trim());
  }
  if (typeof mobileEventId === "string" && mobileEventId.trim()) {
    keys.push("mobile\u0000" + mobileEventId.trim());
  }
  return keys;
}

export function rememberTerminalRun(runId, mobileEventId, terminalCreatedAt) {
  const runs = terminalRuns();
  let changed = false;
  for (const key of terminalRunKeys(runId, mobileEventId)) {
    const existing = runs.get(key);
    if (existing === undefined || existing < terminalCreatedAt) {
      runs.set(key, terminalCreatedAt);
      changed = true;
    }
  }
  if (changed) {
    saveStoredStringArray(TERMINAL_RUNS_KEY, Array.from(runs.entries()).slice(-TERMINAL_RUNS_MAX).map(function (entry) {
      return entry[0] + "\u0000" + entry[1];
    }));
  }
}

export function isSupersededPendingEvent(runId, mobileEventId, createdAt) {
  const runs = terminalRuns();
  return terminalRunKeys(runId, mobileEventId).some(function (key) {
    const terminalAt = runs.get(key);
    return terminalAt !== undefined && createdAt <= terminalAt;
  });
}

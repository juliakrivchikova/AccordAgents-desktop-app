// A running reply's steps folded into one live line, in either view, as on
// the computer (chat-live-steps.tsx; the User, 2026-11-27): the step the
// member is at, in its row's words, shimmering, the newest replacing it. A
// tap opens it to every step so far (the newest rows the server sends, the
// earlier ones counted), which keeps growing while open; a tap folds it. Its
// notices about the run itself stay in view under it.
import { lineIcon } from "../activity/activityData.js";
import { openLiveSteps } from "../sessions/sessionsState.js";
import { SESSIONS_ACTIVITY_ICONS, sessionsActivityElement } from "../sessions/activityRows.js";
import { isPlaceholderTimelineContent } from "../store/timelineRows.js";
import { activitySignature } from "../sync/timelinePayload.js";

/** A reply's rows split into its steps and its notices about the run. */
function liveRows(entry) {
  const rows = Array.isArray(entry.activity) ? entry.activity : [];
  return {
    steps: rows.filter(function (row) { return row && row.notice !== true; }),
    notices: rows.filter(function (row) { return row && row.notice === true; })
  };
}

/** Whether a running reply has a step to name. */
export function hasLiveStep(entry) {
  return liveRows(entry).steps.length > 0;
}

/** What the live line shows, to tell whether to draw it again. */
export function liveStepsSignature(entry, status) {
  const key = entry.rowKey || entry.id;
  return activitySignature(entry) + "|" + (status || "") + (openLiveSteps.has(key) ? "|open" : "");
}

/** The live line and, while open, every step so far; then the notices.
 *  Without a step yet it says where the run stands (`status`), as a line
 *  that does not open. Nothing when it has neither. */
export function liveStepsElement(entry, status) {
  const { steps, notices } = liveRows(entry);
  const newest = steps[steps.length - 1];
  const text = newest ? newest.text : status;
  if (!text && notices.length === 0) return undefined;
  const key = entry.rowKey || entry.id;
  const open = Boolean(newest) && openLiveSteps.has(key);
  const wrap = document.createElement("div");
  wrap.className = "live-steps";
  if (text) {
    const line = document.createElement(newest ? "button" : "div");
    line.className = "sessions-activity-row live-step is-current";
    const kind = newest ? newest.kind : "status";
    line.dataset.activityKind = kind;
    const icon = lineIcon(SESSIONS_ACTIVITY_ICONS[kind] || SESSIONS_ACTIVITY_ICONS.tool, 14);
    icon.setAttribute("stroke-width", "1.75");
    icon.classList.add("sessions-activity-icon");
    const words = document.createElement("span");
    words.className = "sessions-activity-text";
    words.textContent = text;
    line.append(icon, words);
    if (newest) {
      line.type = "button";
      line.dataset.liveSteps = key;
      line.setAttribute("aria-expanded", open ? "true" : "false");
      const caret = lineIcon(["m9 18 6-6-6-6"], 12);
      caret.classList.add("live-step-caret");
      line.append(caret);
    }
    wrap.append(line);
  }
  if (open) {
    // Its newest fold names the step in progress on the line above; opened,
    // it says what that fold came to so far, as the computer's list does.
    const last = steps[steps.length - 1];
    const listed = last && last.folded && entry.activityLiveSummary ? [...steps.slice(0, -1), { ...last, kind: "status", text: entry.activityLiveSummary }] : steps;
    const rows = sessionsActivityElement({ activity: listed, activityMore: entry.activityMore }, false);
    rows.classList.add("live-steps-rows");
    wrap.append(rows);
  }
  if (notices.length) wrap.append(sessionsActivityElement({ activity: notices }, false));
  return wrap;
}

/** A classic row's live line kept in step: right under its meta while the
 *  reply runs with a step, redrawn when its steps change, gone otherwise. */
export function syncLiveSteps(copy, meta, entry) {
  const existing = Array.from(copy.children).find(function (child) { return child.classList.contains("live-steps"); });
  const running = entry.presentation !== "sessions" && entry.author === "agent" && entry.status === "Running" && !entry.scaffolding;
  // Done, its line is gone, and so is whether it was open.
  if (entry.status !== "Running") openLiveSteps.delete(entry.rowKey || entry.id);
  if (!running || !Array.isArray(entry.activity) || entry.activity.length === 0) {
    existing?.remove();
    return;
  }
  const signature = liveStepsSignature(entry, "");
  let node = existing;
  if (!node || node.dataset.liveSignature !== signature) {
    node = liveStepsElement(entry, "");
    if (!node) {
      existing?.remove();
      return;
    }
    node.dataset.liveSignature = signature;
    if (existing) existing.replaceWith(node);
  }
  if (meta.parentElement === copy) {
    if (meta.nextSibling !== node) meta.after(node);
  } else if (copy.firstChild !== node) {
    copy.prepend(node);
  }
}

/** Whether a classic running row's text only says where the run stands
 *  (its step, a status, a notice, the placeholder), not words of the reply,
 *  while it has rows to show instead. */
function classicStatusText(entry) {
  return entry.presentation !== "sessions" && entry.author === "agent" && entry.status === "Running" && !entry.scaffolding &&
    Array.isArray(entry.activity) && entry.activity.length > 0 && (entry.liveStatus === true || isPlaceholderTimelineContent(entry.content));
}

/** A classic running row whose live line names its step: no text of its own
 *  besides (the line says it once). */
export function classicLineOnly(entry) {
  return classicStatusText(entry) && hasLiveStep(entry);
}

/** A classic running row with only notices so far: "Thinking", as the
 *  computer shows it, while its text is a notice already drawn as its row
 *  (or the placeholder); a machine's status stays its text. */
export function classicThinking(entry) {
  if (!classicStatusText(entry) || hasLiveStep(entry)) return false;
  const text = String(entry.content || "").trim();
  return isPlaceholderTimelineContent(text) || liveRows(entry).notices.some(function (row) {
    const shown = String(row.text || "").replace(/…$/, "").trim();
    return Boolean(shown) && text.indexOf(shown) === 0;
  });
}

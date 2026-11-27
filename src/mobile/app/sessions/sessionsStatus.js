import { lineIcon } from "../activity/activityData.js";
import { nowIso } from "../base/bytes.js";
import { liveStepsElement, liveStepsSignature } from "../chat/liveSteps.js";
import { sessionsActivityElement } from "./activityRows.js";
import { isThinkingEntry } from "../chat/messageRows.js";
import { memberKindLabel } from "../members/membersSheet.js";
import { sessionsDelegationsElement } from "./sessionsCards.js";
import { openWorkedFolds, sessionsRules } from "./sessionsState.js";
import { SVG_NS } from "../shell/home.js";
import { activitySignature } from "../sync/timelinePayload.js";

/** A desktop-style running time: 12s, 3m 4s, 1h 2m. */
export function formatWorked(startedAt) {
  const started = Date.parse(startedAt || "");
  return formatWorkedMs(Number.isFinite(started) ? Date.now() - started : 0);
}

export function formatWorkedMs(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return hours + "h " + minutes + "m";
  if (minutes > 0) return minutes + "m " + (total % 60) + "s";
  return (total % 60) + "s";
}

export function sessionsElapsedElement(since, className) {
  const node = document.createElement("span");
  node.className = "sessions-elapsed" + (className ? " " + className : "");
  node.dataset.startedAt = since;
  node.textContent = node.classList.contains("is-compact") ? compactElapsed(since) : formatWorked(since);
  return node;
}

/** A side panel row's time, T3 Code's short way ("5s", "8m", "1.5h"), by
 *  the computer's rule (shared sessionsCompactDuration). */
export function compactDuration(ms) {
  const shared = sessionsRules();
  return shared && typeof shared.sessionsCompactDuration === "function" ? shared.sessionsCompactDuration(ms) : formatWorkedMs(ms);
}

export function compactElapsed(startedAt) {
  const started = Date.parse(startedAt || "");
  return compactDuration(Number.isFinite(started) ? Date.now() - started : 0);
}

export function sessionsStatusElement(status) {
  const shared = sessionsRules();
  const node = document.createElement("span");
  node.className = "sessions-status is-" + status;
  node.dataset.workStatus = status;
  const dot = document.createElement("span");
  dot.className = "sessions-status-dot";
  dot.setAttribute("aria-hidden", "true");
  node.append(dot, document.createTextNode(shared ? shared.SESSIONS_WORK_STATUS_LABELS[status] || status : status));
  return node;
}

export function sessionsStopButton(participantIds, canStop, stopping, label, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sessions-stop" + (className ? " " + className : "");
  button.dataset.stopMembers = participantIds.join(",");
  button.disabled = stopping || !canStop;
  button.textContent = stopping ? "Stopping…" : "Stop";
  if (label) button.setAttribute("aria-label", label);
  return button;
}

// The desktop's Codex mark (provider-icon.tsx), drawn inline: the phone's
// provider tiles match Settings → Local CLI setup and the desktop's
// sessions view. Claude's and Antigravity's are the same pictures.
const CODEX_MARK_PATH = "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z";

let codexMarkCount = 0;

/** A member's provider logo tile (no avatar picture anywhere in the
 *  sessions view); an empty tile for a member whose provider is not known
 *  (one that left the chat). */
/** A member's provider mark. In the sessions view the bare glyph (Claude's
 *  orange asterisk, Codex's glyph, Antigravity's "A") sized to the text
 *  beside it, as T3 Code shows it (the User, 2026-11-21); `options.tile`
 *  puts it on its logo tile (the classic New chat's main session row). */
export function providerLogoElement(kind, className, options) {
  const tile = document.createElement("span");
  tile.className = "provider-logo" + (className ? " " + className : "") + (options && options.tile ? "" : " is-bare");
  tile.dataset.providerKind = kind || "unknown";
  const label = memberKindLabel(kind);
  if (label) {
    tile.setAttribute("role", "img");
    tile.setAttribute("aria-label", label);
  } else {
    tile.setAttribute("aria-hidden", "true");
  }
  if (kind === "codex-cli") {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const gradientId = "provider-codex-gradient-" + (codexMarkCount += 1);
    const defs = document.createElementNS(SVG_NS, "defs");
    const gradient = document.createElementNS(SVG_NS, "linearGradient");
    gradient.setAttribute("id", gradientId);
    for (const [name, value] of [["x1", "12"], ["x2", "12"], ["y1", "0"], ["y2", "24"], ["gradientUnits", "userSpaceOnUse"]]) gradient.setAttribute(name, value);
    for (const [offset, stopClass] of [["0", "is-top"], [".5", "is-mid"], ["1", "is-bottom"]]) {
      const stop = document.createElementNS(SVG_NS, "stop");
      stop.setAttribute("offset", offset);
      stop.setAttribute("class", "provider-codex-stop " + stopClass);
      gradient.append(stop);
    }
    defs.append(gradient);
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("fill", "url(#" + gradientId + ")");
    path.setAttribute("fill-rule", "evenodd");
    path.setAttribute("clip-rule", "evenodd");
    path.setAttribute("d", CODEX_MARK_PATH);
    svg.append(defs, path);
    tile.append(svg);
  } else if (kind === "claude-code" || kind === "gemini-cli") {
    const mark = document.createElement("span");
    mark.className = "provider-logo-mark " + (kind === "claude-code" ? "is-claude" : "is-antigravity");
    mark.setAttribute("aria-hidden", "true");
    tile.append(mark);
  }
  return tile;
}

/** A member's logo with its task's state as a dot at its corner (T3's
 *  delegation row). */
function providerLogoWithStatus(kind, status) {
  const wrap = document.createElement("span");
  wrap.className = "sessions-logo";
  const dot = document.createElement("span");
  dot.className = "sessions-logo-dot is-" + status;
  dot.setAttribute("aria-hidden", "true");
  wrap.append(providerLogoElement(kind), dot);
  return wrap;
}

/** One delegated task: its member's logo with the task's state, the task
 *  in bold, one muted line of its result, its time, and the way into the
 *  member's session at the message it refers to. */
export function sessionsDelegationRowElement(view) {
  const shared = sessionsRules();
  const row = document.createElement("button");
  row.type = "button";
  row.className = "sessions-delegation";
  row.dataset.openMember = view.participantId;
  row.dataset.focusMessage = view.focus || "";
  row.dataset.taskStatus = view.status;
  row.setAttribute("aria-label", view.title + ": " + (shared ? shared.SESSIONS_WORK_STATUS_LABELS[view.status] : view.status));
  const main = document.createElement("span");
  main.className = "sessions-delegation-main";
  const title = document.createElement("strong");
  title.className = "sessions-delegation-title";
  title.textContent = view.title;
  main.append(title);
  if (view.line) {
    const result = document.createElement("span");
    result.className = "sessions-delegation-result" + (view.lineMuted ? " is-muted" : "");
    result.textContent = view.line;
    main.append(result);
  }
  row.append(providerLogoWithStatus(view.kind, view.status), main);
  if (view.since) row.append(sessionsElapsedElement(view.since, "sessions-delegation-time"));
  else if (typeof view.durationMs === "number") {
    const time = document.createElement("span");
    time.className = "sessions-delegation-time";
    time.textContent = formatWorkedMs(view.durationMs);
    row.append(time);
  }
  row.append(lineIcon(["m9 18 6-6-6-6"], 14));
  return row;
}

/** What a reply's "Worked for …" shows, to tell whether to draw it again;
 *  empty when it shows none. */
export function sessionsWorkedSignature(entry) {
  if (entry.presentation !== "sessions") return "";
  if (entry.delegations && !entry.delegations.standalone) return "delegations:" + JSON.stringify(entry.delegations);
  if (entry.delegations || entry.status !== "Done") return "";
  const steps = activitySignature(entry);
  if (typeof entry.workedMs !== "number" && !steps) return "";
  if (entry.turnContinues) return "continued:" + steps + (openWorkedFolds.has(entry.rowKey || entry.id) ? ":open" : "");
  return "worked:" + (typeof entry.workedMs === "number" ? entry.workedMs : "") +
    (steps ? ":" + steps + (openWorkedFolds.has(entry.rowKey || entry.id) ? ":open" : "") : "");
}

// --- a running reply's work (T3 Code's turn in progress) --------------------
// The sessions view's running reply (the User, 2026-11-21), as on the
// desktop: a quiet "Working for 4s" over a hairline, then its steps folded
// into one live line naming the step in progress, shimmering, which opens to
// one row per step, an outline icon by its kind and what it is about in
// muted text (liveSteps.js; the User, 2026-11-27). No status label, no
// "Thinking" word, no Stop on the reply (the composer's button stops it).
// Once done, its "Worked for …" opens to the same rows.

/** A reply of the sessions view still being written. */
export function isSessionsRunningEntry(entry) {
  return Boolean(entry) && entry.presentation === "sessions" && entry.author === "agent" && entry.status === "Running" && !entry.scaffolding;
}


/** A running reply's own words so far: none while its text is only the
 *  placeholder or where the run stands (shown as a step instead). */
export function sessionsRunningText(entry) {
  return isThinkingEntry(entry) || entry.liveStatus ? "" : entry.content;
}

/** Where a run stands, as its current step, until it has steps of its own
 *  ("Preparing the workspace" on a machine). */
function sessionsRunningStatus(entry) {
  if (!entry.liveStatus || (Array.isArray(entry.activity) && entry.activity.length) || isThinkingEntry(entry)) return "";
  const text = String(entry.content || "").replace(/\s+/g, " ").trim();
  return /^(thinking|running)\b/i.test(text) ? "" : text;
}


/** "Working for 4s" (ticking, startThinkingClock) over a hairline, then
 *  the reply's live step line (or where the run stands) and its notices. */
function sessionsWorkingElement(entry) {
  const wrap = document.createElement("div");
  wrap.className = "sessions-working";
  const head = document.createElement("div");
  head.className = "sessions-working-head";
  head.setAttribute("role", "status");
  // From the turn's own start (a machine's run, once it started), not from
  // when the reply was queued, as on the desktop.
  head.append(document.createTextNode("Working for "), sessionsElapsedElement(entry.startedAt || entry.createdAt || nowIso()));
  wrap.append(head);
  const steps = liveStepsElement(entry, sessionsRunningStatus(entry));
  if (steps) wrap.append(steps);
  return wrap;
}

/** A row updated in place keeps its "Working for …" in step: right under
 *  its meta while it runs, redrawn when its steps change, gone once done. */
export function syncSessionsWorking(copy, meta, entry) {
  const existing = Array.from(copy.children).find(function (child) { return child.classList.contains("sessions-working"); });
  // Queued: its meta says so; it works for nothing yet.
  if (!isSessionsRunningEntry(entry) || entry.queued) {
    existing?.remove();
    return;
  }
  const signature = (entry.startedAt || entry.createdAt || "") + "|" + liveStepsSignature(entry, sessionsRunningStatus(entry));
  let node = existing;
  if (!node || node.dataset.workingSignature !== signature) {
    node = sessionsWorkingElement(entry);
    node.dataset.workingSignature = signature;
    if (existing) existing.replaceWith(node);
  }
  if (meta.parentElement === copy) {
    if (meta.nextSibling !== node) meta.after(node);
  } else if (copy.firstChild !== node) {
    copy.prepend(node);
  }
}

/** A row updated in place keeps its "Worked for …" and its turn's tasks
 *  in step: added when the reply finishes on screen, redrawn when they
 *  change, where a new row puts them (above the reply's words, or under
 *  them while it is written), gone when it shows none. */
export function syncSessionsWorked(copy, meta, content, entry) {
  const existing = Array.from(copy.children).find(function (child) {
    return child.classList.contains("sessions-worked") || child.classList.contains("sessions-delegations");
  });
  const signature = sessionsWorkedSignature(entry);
  if (!signature) {
    existing?.remove();
    return;
  }
  let node = existing;
  if (!node || node.dataset.workedSignature !== signature) {
    node = entry.delegations ? sessionsDelegationsElement(entry.delegations) : sessionsWorkedElement(entry);
    if (!node) {
      existing?.remove();
      return;
    }
    node.dataset.workedSignature = signature;
    existing?.remove();
  }
  if (entry.delegations && entry.delegations.live) {
    if (content.nextSibling !== node) content.after(node);
  } else if (meta.parentElement === copy) {
    if (meta.nextSibling !== node) meta.after(node);
  } else if (copy.firstChild !== node) {
    copy.prepend(node);
  }
}

/** "Worked for 44s" above a finished reply of the sessions view that gave
 *  no tasks: muted text, as the fold of one that did. */
export function sessionsWorkedElement(entry) {
  const steps = Array.isArray(entry.activity) && entry.activity.length > 0;
  if (entry.presentation === "sessions" && !entry.delegations && entry.status === "Done" && entry.turnContinues) {
    // A part its turn went on from (her next message joined it): no "Worked
    // for" of its own; its steps fold into "N steps ›" (the User, 2026-11-27).
    if (!steps) return undefined;
    return foldElement(entry, stepsCountLabel(entry), "is-continued");
  }
  if (entry.presentation !== "sessions" || entry.delegations || entry.status !== "Done" || (typeof entry.workedMs !== "number" && !steps)) return undefined;
  const label = typeof entry.workedMs === "number" ? "Worked for " + formatWorkedMs(entry.workedMs) : "Worked";
  const wrap = document.createElement("div");
  if (!steps) {
    wrap.className = "sessions-worked is-plain";
    const text = document.createElement("span");
    text.className = "sessions-worked-label";
    text.textContent = label;
    wrap.append(text);
    return wrap;
  }
  // Its steps: the fold opens to the rows its turn showed while it ran.
  return foldElement(entry, label, "");
}

/** "N steps": how many steps a part of a turn folds (a folded row stands
 *  for several; the server counts them where it does). */
export function stepsCountLabel(entry) {
  const count = entry.activitySteps || (Array.isArray(entry.activity) ? entry.activity.length : 0) + (entry.activityMore || 0);
  return count === 1 ? "1 step" : count + " steps";
}

/** A fold's toggle: its label and a chevron (openWorkedFolds by `key`). */
export function stepsFoldToggle(key, label, open) {
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "sessions-worked-toggle";
  toggle.dataset.workedFold = key;
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  const text = document.createElement("span");
  text.textContent = label;
  toggle.append(text, lineIcon([open ? "m6 9 6 6 6-6" : "m9 18 6-6-6-6"], 14));
  return toggle;
}

/** A fold of a reply's steps: its label and a chevron, opening to its rows. */
function foldElement(entry, label, className) {
  const wrap = document.createElement("div");
  const key = entry.rowKey || entry.id;
  const open = openWorkedFolds.has(key);
  wrap.className = "sessions-worked" + (className ? " " + className : "") + (open ? " is-open" : "");
  wrap.append(stepsFoldToggle(key, label, open));
  if (open) {
    const body = document.createElement("div");
    body.className = "sessions-worked-body";
    body.append(sessionsActivityElement(entry, false));
    wrap.append(body);
  }
  return wrap;
}

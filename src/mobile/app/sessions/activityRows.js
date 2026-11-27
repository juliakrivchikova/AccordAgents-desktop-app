// A reply's steps as rows, on the phone as on the computer
// (chat-activity-rows.tsx): one quiet line per step, an outline icon by its
// kind and what it is about in muted text. Drawn by a running reply's live
// line when opened (chat/liveSteps.js) and by a finished reply's folds
// (sessionsStatus.js, sessionsCards.js).
import { lineIcon } from "../activity/activityData.js";

// Outline icons by step (lucide's brain, globe, terminal, file-text, pencil,
// wrench and activity), the desktop's own.
export const SESSIONS_ACTIVITY_ICONS = {
  thinking: ["M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z", "M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z",
    "M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4", "M17.599 6.5a3 3 0 0 0 .399-1.375", "M6.003 5.125A3 3 0 0 0 6.401 6.5", "M3.477 10.896a4 4 0 0 1 .585-.396",
    "M19.938 10.5a4 4 0 0 1 .585.396", "M6 18a4 4 0 0 1-1.967-.516", "M19.967 17.484A4 4 0 0 1 18 18"],
  web: ["M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20", "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20", "M2 12h20"],
  shell: ["m4 17 6-6-6-6", "M12 19h8"],
  read: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4", "M10 9H8", "M16 13H8", "M16 17H8"],
  edit: ["M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z", "m15 5 4 4"],
  tool: ["M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"],
  status: ["M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"]
};

/** A reply's steps, one row each; while `live`, the newest is the current one. */
export function sessionsActivityElement(entry, live) {
  const list = document.createElement("div");
  list.className = "sessions-activity";
  const rows = Array.isArray(entry.activity) ? entry.activity : [];
  if (entry.activityMore > 0) {
    const more = document.createElement("div");
    more.className = "sessions-activity-more";
    more.textContent = entry.activityMore === 1 ? "1 earlier step" : entry.activityMore + " earlier steps";
    list.append(more);
  }
  rows.forEach(function (row, index) {
    const line = document.createElement("div");
    line.className = "sessions-activity-row is-" + row.kind + (row.folded ? " is-folded" : "") + (live && index === rows.length - 1 ? " is-current" : "");
    line.dataset.activityKind = row.kind;
    // Steps folded into one line, as Claude Code folds them, are words alone.
    if (!row.folded) {
      const icon = lineIcon(SESSIONS_ACTIVITY_ICONS[row.kind] || SESSIONS_ACTIVITY_ICONS.tool, 14);
      icon.setAttribute("stroke-width", "1.75");
      icon.classList.add("sessions-activity-icon");
      line.append(icon);
    }
    const text = document.createElement("span");
    text.className = "sessions-activity-text";
    text.textContent = row.text;
    line.append(text);
    list.append(line);
  });
  return list;
}

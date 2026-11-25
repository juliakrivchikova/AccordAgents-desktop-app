import { lineIcon } from "../activity/activityData.js";
import { pendingAttachments, pickedImagesState } from "./pickedImages.js";
import { sessionsCanStop, sessionsStopping } from "../sessions/sessionsState.js";
import { SVG_NS } from "../shell/home.js";

// The sessions view the composer last drew its button for, and whose run
// it stops: the main session's on the main timeline, a member's in its
// session.
export let composerStopState;

export let composerStopIds = [];

/** The sessions view's composer, as the desktop's: while the session it
 *  writes to runs (the main session on the main timeline, the member in
 *  its session) and nothing is written, its send button stops that run
 *  (T3 Code's and Claude's Stop); with something written it is Send again
 *  and Stop stands beside it, since the CLI interrupts whatever is typed.
 *  Members are stopped from the panel and their own sessions. */
export function syncComposerStop(state, memberId) {
  composerStopState = state;
  // Drawn again for the same screen (typing, a run starting or ending):
  // it keeps stopping whom it stopped, a member in its session included.
  if (arguments.length < 2 && state) {
    // composerStopIds stay as the screen last set them.
  } else if (memberId !== undefined || !state) composerStopIds = state && memberId ? [memberId] : [];
  else composerStopIds = state.mainId ? [state.mainId] : [];
  const button = document.getElementById("send-button");
  const input = document.getElementById("composer-input");
  if (!button || !input) return;
  const empty = !input.value.trim() && pendingAttachments.length === 0 && pickedImagesState.attachmentsPreparing === 0;
  const ids = composerStopIds;
  const canStop = ids.length > 0 && sessionsCanStop(state, ids);
  const stopping = ids.length > 0 && !canStop && sessionsStopping(state, ids);
  const side = document.getElementById("composer-stop-button");
  if (side) {
    side.hidden = empty || (!canStop && !stopping);
    side.disabled = !canStop;
    side.setAttribute("aria-label", stopping ? "Stopping" : ids[0] && state && ids[0] === state.mainId ? "Stop" : "Stop this member");
  }
  const mode = empty && canStop ? "stop" : empty && stopping ? "stopping" : "send";
  // The main session is named by nothing in the sessions view.
  const whose = ids[0] && state && ids[0] === state.mainId ? "" : " this member";
  button.setAttribute("aria-label", mode === "send" ? "Send message" : mode === "stop" ? "Stop" + whose : "Stopping" + whose);
  if ((button.dataset.mode || "send") === mode) return;
  button.dataset.mode = mode;
  button.classList.toggle("is-stop", mode !== "send");
  button.type = mode === "send" ? "submit" : "button";
  button.disabled = mode === "stopping";
  if (mode === "send") {
    const icon = lineIcon(["M12 19V5M5 12l7-7 7 7"], 19);
    icon.setAttribute("stroke-width", "2.1");
    button.replaceChildren(icon);
  } else {
    const icon = document.createElementNS(SVG_NS, "svg");
    icon.setAttribute("width", "14");
    icon.setAttribute("height", "14");
    icon.setAttribute("viewBox", "0 0 14 14");
    icon.setAttribute("aria-hidden", "true");
    const square = document.createElementNS(SVG_NS, "rect");
    square.setAttribute("x", "1.5");
    square.setAttribute("y", "1.5");
    square.setAttribute("width", "11");
    square.setAttribute("height", "11");
    square.setAttribute("rx", "2");
    square.setAttribute("fill", "currentColor");
    icon.append(square);
    button.replaceChildren(icon);
  }
}

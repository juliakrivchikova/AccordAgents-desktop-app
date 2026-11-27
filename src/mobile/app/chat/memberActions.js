// Settings → General → Show members’ actions on the computer (the User,
// 2026-11-27): while it is off, the phone draws no steps in a reply, and a
// running reply whose live line names the step in progress says it is
// working instead. Her server hands the setting over with every answer to
// /v1/phone/changes (HubPhoneDisplay); it is kept here so the phone draws
// the same before its first answer.
const MEMBER_ACTIONS_KEY = "accordagents.display.showMemberActions";

let shown = readShown();

function readShown() {
  try {
    return localStorage.getItem(MEMBER_ACTIONS_KEY) !== "0";
  } catch {
    return true;
  }
}

export function memberActionsShown() {
  return shown;
}

/** The setting from a server answer; true when it changed what is drawn. A
 *  server or computer from before says nothing: the phone keeps its own. */
export function noteServerDisplay(display) {
  if (!display || typeof display.showMemberActions !== "boolean" || display.showMemberActions === shown) return false;
  shown = display.showMemberActions;
  try {
    localStorage.setItem(MEMBER_ACTIONS_KEY, shown ? "1" : "0");
  } catch {
    // Drawn as the server says for now; the next answer says it again.
  }
  return true;
}

/** A running reply's live text while actions are hidden: the step in
 *  progress (liveActivity) becomes the placeholder that says it is working. */
export function shownLiveContent(entry, actionsShown) {
  if (actionsShown || !entry.liveActivity) return entry.content;
  return entry.participantLabel ? entry.participantLabel + " is running..." : "Running...";
}

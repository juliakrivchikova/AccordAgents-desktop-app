import { hubPhoneGet } from "../sync/serverReads.js";

// --- the "/" menu ---------------------------------------------------------
// What the desktop composer lists after "/": /compact and /goal for one clear
// member, saved prompts, and the skills the target member can run. The
// desktop decides the list; the phone only asks with the draft so far.

export function activeSlashQuery(value) {
  const match = String(value || "").match(/(?:^|\s)\/([A-Za-z0-9_-]*)$/);
  return match ? match[1] : undefined;
}

export function replaceActiveSlashQuery(value, insertion) {
  const source = String(value || "");
  const match = source.match(/(?:^|\s)\/([A-Za-z0-9_-]*)$/);
  if (!match || match.index === undefined) {
    return source + (source.endsWith(" ") || !source ? "" : " ") + insertion;
  }
  const prefix = source.slice(0, match.index);
  const leadingSpace = match[0].startsWith(" ") ? " " : "";
  return prefix + leadingSpace + insertion;
}

export function replaceSlashAtCaret(value, insertion, caret) {
  const source = String(value || "");
  const position = Number.isFinite(caret)
    ? Math.max(0, Math.min(source.length, caret))
    : source.length;
  const replacedBefore = replaceActiveSlashQuery(source.slice(0, position), insertion);
  const after = source.slice(position);
  const suffix = replacedBefore.endsWith(" ") && after.startsWith(" ") ? after.slice(1) : after;
  return { value: replacedBefore + suffix, caret: replacedBefore.length };
}

export function skillTokenPresent(value, frontmatterName) {
  const escaped = String(frontmatterName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(^|\\s)/" + escaped + "(?=\\s|$)").test(String(value || ""));
}

export async function requestComposerOptionsViaRelay(pairing, conversationId, query, content) {
  // The catalog the desktop published on the server, answered there.
  const payload = await hubPhoneGet("/v1/phone/composer", { conversationId: conversationId, query: query, content: String(content || "").slice(0, 2_000) });
  if (!payload || payload.type !== "mobile.composer") {
    return { commands: [], prompts: [], skills: [] };
  }
  return {
    commands: Array.isArray(payload.commands) ? payload.commands : [],
    prompts: Array.isArray(payload.prompts) ? payload.prompts : [],
    skills: Array.isArray(payload.skills) ? payload.skills : []
  };
}

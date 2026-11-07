import { spacedDictation } from "../../../shared/speechToText";

/** What a message field belongs to (a chat, a thread, New chat): text spoken
 *  for one never lands in another that reuses the same field. */
export const DICTATION_SESSION_ATTRIBUTE = "data-dictation-session";

/** Fields text can be typed into; email fields refuse a caret position. */
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", ""]);

export type DictationTarget =
  | { kind: "field"; element: HTMLTextAreaElement | HTMLInputElement; start: number; end: number; session: string | null }
  | { kind: "editable"; element: HTMLElement; range?: Range; session: string | null };

/** The chat, thread or New chat a field belongs to, if any. */
export function dictationSessionOf(element: Element): string | null {
  return element.closest(`[${DICTATION_SESSION_ATTRIBUTE}]`)?.getAttribute(DICTATION_SESSION_ATTRIBUTE) ?? null;
}

/** The field that has the cursor now, if dictated text can go into it. The
 *  terminal is not one: text typed there would run in the program. */
export function currentDictationTarget(): DictationTarget | undefined {
  const element = document.activeElement;
  if (!(element instanceof HTMLElement) || element.closest(".xterm")) return undefined;
  const session = dictationSessionOf(element);
  if (element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(element.type))) {
    if (element.readOnly || element.disabled) return undefined;
    return {
      kind: "field",
      element,
      start: element.selectionStart ?? element.value.length,
      end: element.selectionEnd ?? element.value.length,
      session
    };
  }
  if (element.isContentEditable) {
    const selection = window.getSelection();
    return { kind: "editable", element, range: selection && selection.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined, session };
  }
  return undefined;
}

/**
 * Types the text where the cursor was, as if typed: the field's own input
 * handling runs, and Undo takes it out again. False when the field is gone,
 * now belongs to another chat or thread, or cannot take the text without
 * pulling the cursor out of a field she is typing in.
 */
export function insertDictation(target: DictationTarget, text: string): boolean {
  const { element } = target;
  if (!element.isConnected || dictationSessionOf(element) !== target.session) return false;
  const active = document.activeElement;
  const typingElsewhere = active !== element && active instanceof HTMLElement && isEditable(active);
  if (!typingElsewhere && active !== element) element.focus();
  const hasFocus = document.activeElement === element;
  if (target.kind === "field") {
    const field = target.element;
    const keepsCaret = hasFocus && active === element;
    const start = keepsCaret ? field.selectionStart ?? target.start : Math.min(target.start, field.value.length);
    const end = keepsCaret ? field.selectionEnd ?? target.end : Math.min(target.end, field.value.length);
    const insert = spacedDictation(field.value.slice(0, start), field.value.slice(end), text);
    if (!insert) return true;
    if (hasFocus) {
      field.setSelectionRange(start, end);
      if (typeText(insert)) return true;
    }
    // Without the focus (a dialog or another field has it), the text goes in
    // directly, through the same input handling.
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
    if (!setter) return false;
    setter.call(field, `${field.value.slice(0, start)}${insert}${field.value.slice(end)}`);
    if (hasFocus) field.setSelectionRange(start + insert.length, start + insert.length);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  if (!hasFocus) return false;
  if (active !== element && target.range) {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(target.range);
  }
  return typeText(text.trim());
}

function isEditable(element: HTMLElement): boolean {
  return element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement || element.isContentEditable;
}

/** Typing through the browser keeps Undo and the field's own handling. */
function typeText(text: string): boolean {
  return typeof document.execCommand === "function" && document.execCommand("insertText", false, text);
}

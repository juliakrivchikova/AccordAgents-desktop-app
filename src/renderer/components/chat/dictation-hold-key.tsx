import { useEffect, useRef, useState } from "react";
import { Copy, Loader2, X } from "lucide-react";

import { writeClipboardText } from "../../../shared/clipboard";
import {
  SPEECH_HOLD_KEY_LABELS,
  formatSpeechElapsed,
  isHoldKeyEvent,
  spacedDictation,
  type SpeechHoldKey
} from "../../../shared/speechToText";
import { useSpeechToTextState } from "../../app/use-speech-to-text";
import { useDictation } from "./use-dictation";

/** Held this long alone, the key starts dictation; sooner, or with another
 *  key or a click, it is the usual Option (a shortcut or a special character). */
export const HOLD_TO_DICTATE_MS = 300;
/** The window with text that had nowhere to go closes after this. */
export const RESULT_VISIBLE_MS = 8_000;
/** Fields text can be typed into; email fields refuse a caret position. */
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", ""]);
/** What a message field belongs to (a chat, a thread, New chat): text spoken
 *  for one never lands in another that reuses the same field. */
export const DICTATION_SESSION_ATTRIBUTE = "data-dictation-session";

type Target =
  | { kind: "field"; element: HTMLTextAreaElement | HTMLInputElement; start: number; end: number; session: string | null }
  | { kind: "editable"; element: HTMLElement; range?: Range; session: string | null };

type ResultReason = "no-field" | "field-gone";

/**
 * Dictation by holding a key while the app is in front: the text goes where
 * the cursor was when she pressed it, or, when that field is not there to take
 * it, into a small window she can copy it from.
 */
export function DictationHoldKey(): JSX.Element | null {
  const state = useSpeechToTextState();
  const holdKey: SpeechHoldKey = state?.status === "ready" ? state.holdKey : "off";
  const [result, setResult] = useState<{ text: string; reason: ResultReason }>();
  const targetRef = useRef<Target>();
  const dictation = useDictation({
    session: "hold-key",
    onText: (text) => {
      const target = targetRef.current;
      targetRef.current = undefined;
      let inserted = false;
      try {
        inserted = target ? insertInto(target, text) : false;
      } catch {
        inserted = false;
      }
      // What could not be typed in waits to be copied.
      if (!inserted) setResult({ text, reason: target ? "field-gone" : "no-field" });
    }
  });
  const dictationRef = useRef(dictation);
  dictationRef.current = dictation;

  useEffect(() => {
    if (holdKey === "off") return undefined;
    let timer: number | undefined;
    let holding = false;
    let released = false;
    const cancelWait = (): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };
    const finish = (): void => {
      cancelWait();
      if (!holding) return;
      holding = false;
      released = true;
      void dictationRef.current.stop();
    };
    // The key was part of a shortcut (Option+arrow, Option+click): what was
    // recorded is dropped, never typed in.
    const abandon = (): void => {
      cancelWait();
      if (!holding) return;
      holding = false;
      released = true;
      targetRef.current = undefined;
      dictationRef.current.cancel();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isHoldKeyEvent(holdKey, event)) {
        abandon();
        return;
      }
      if (event.repeat || holding || timer !== undefined) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey) return;
      const target = currentTarget();
      timer = window.setTimeout(() => {
        timer = undefined;
        if (dictationRef.current.phase !== "idle") {
          // Shows why nothing records (still recognizing the last one).
          void dictationRef.current.start();
          return;
        }
        holding = true;
        released = false;
        targetRef.current = target;
        void dictationRef.current.start().then(() => {
          // Let go while the microphone was still starting.
          if (released) void dictationRef.current.stop();
        });
      }, HOLD_TO_DICTATE_MS);
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (isHoldKeyEvent(holdKey, event)) finish();
    };
    const onPointerDown = (): void => abandon();
    // A release the page never heard (a menu took it): the next pointer move
    // without Option ends the recording as if the key were let go.
    const onPointerMove = (event: PointerEvent): void => {
      if (holding && !event.altKey) finish();
    };
    // Switching away while holding never leaves the microphone on.
    const onBlur = (): void => finish();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("blur", onBlur);
      abandon();
    };
  }, [holdKey]);

  const keyName = holdKey === "right-option" ? "right Option" : SPEECH_HOLD_KEY_LABELS.option;
  return (
    <>
      {/* This dictation is only ever started by the key. */}
      {dictation.phase !== "idle" || dictation.notice ? (
        <div className="dictation-hold-pill" role="status" data-testid="dictation-hold-status">
          {dictation.phase === "recording" ? (
            <>
              <span className="composer-dictation-dot" aria-hidden />
              <span className="dictation-hold-time">{formatSpeechElapsed(dictation.seconds)}</span>
              <span>Listening. Release {keyName} to insert.</span>
            </>
          ) : dictation.phase === "starting" || dictation.phase === "recognizing" ? (
            <>
              <Loader2 size={13} className="spin" aria-hidden />
              <span>{dictation.phase === "starting" ? "Starting the microphone…" : "Recognizing…"}</span>
            </>
          ) : dictation.notice ? (
            <>
              <span className={dictation.notice.kind === "error" ? "dictation-hold-error" : undefined}>{dictation.notice.text}</span>
              <button type="button" className="dictation-hold-close" aria-label="Dismiss" onClick={dictation.dismissNotice}>
                <X size={13} aria-hidden />
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {result ? <DictationResult text={result.text} reason={result.reason} onClose={() => setResult(undefined)} /> : null}
    </>
  );
}

/** Text that had no field to go into: copy it, or close; it closes by
 *  itself after a few seconds unless the pointer or focus is on it. */
function DictationResult(props: { text: string; reason: ResultReason; onClose: () => void }): JSX.Element {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  // A failed copy keeps the window open: the text is still only here.
  const paused = hovered || focused || copy === "failed";
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  useEffect(() => {
    if (paused) return undefined;
    const timer = window.setTimeout(() => onCloseRef.current(), RESULT_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [paused, props.text]);
  return (
    <div
      className="dictation-result"
      role="dialog"
      aria-label="Dictated text"
      data-testid="dictation-result"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onClose();
      }}
    >
      <div className="dictation-result-head">
        <span aria-live="polite">
          {props.reason === "field-gone"
            ? "The field you dictated into is no longer here. Copy the text."
            : "No text field was selected. Copy the text, or click a field before you dictate."}
        </span>
        <button type="button" className="dictation-result-close" aria-label="Close" data-paused={paused || undefined} onClick={props.onClose}>
          <svg viewBox="0 0 24 24" aria-hidden className="dictation-result-ring">
            {/* The ring empties in the same time the window takes to close. */}
            <circle cx="12" cy="12" r="10.5" key={paused ? "paused" : props.text} style={{ animationDuration: `${RESULT_VISIBLE_MS}ms` }} />
          </svg>
          <X size={12} aria-hidden />
        </button>
      </div>
      <p className="dictation-result-text" data-testid="dictation-result-text">{props.text}</p>
      <div className="dictation-result-actions">
        {copy === "failed" ? <span className="dictation-hold-error">Copy failed. Select the text and copy it.</span> : null}
        <button
          type="button"
          className="dictation-result-copy"
          data-testid="dictation-result-copy"
          onClick={() => {
            void writeClipboardText(props.text, (value) => navigator.clipboard.writeText(value)).then(setCopy);
          }}
        >
          <Copy size={13} aria-hidden />
          {copy === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/** The field that has the cursor now, if dictated text can go into it. The
 *  terminal is not one: text typed there would run in the program. */
function currentTarget(): Target | undefined {
  const element = document.activeElement;
  if (!(element instanceof HTMLElement) || element.closest(".xterm")) return undefined;
  const session = element.closest(`[${DICTATION_SESSION_ATTRIBUTE}]`)?.getAttribute(DICTATION_SESSION_ATTRIBUTE) ?? null;
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
export function insertInto(target: Target, text: string): boolean {
  const { element } = target;
  if (!element.isConnected) return false;
  const session = element.closest(`[${DICTATION_SESSION_ATTRIBUTE}]`)?.getAttribute(DICTATION_SESSION_ATTRIBUTE) ?? null;
  if (session !== target.session) return false;
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

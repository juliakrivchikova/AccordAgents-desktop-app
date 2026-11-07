import { useCallback, useEffect, useRef, useState } from "react";

import {
  SPEECH_MAX_SECONDS,
  SpeechPieces,
  encodeWavPcm16,
  joinTranscripts,
  speechHasVoice,
  speechPromptFrom
} from "../../../shared/speechToText";
import { cleanIpcError } from "../../lib/ipc-error";
import { startSpeechRecorder, type SpeechRecorder } from "./speech-recorder";

export type DictationPhase = "idle" | "starting" | "recording" | "recognizing";

/** An error stays until she dismisses it or dictates again; a hint fades. */
export interface DictationNotice {
  text: string;
  kind: "error" | "hint";
}

const MICROPHONE_OFF =
  "Microphone access is off for AccordAgents. Turn it on in System Settings › Privacy & Security › Microphone.";
const NOTHING_HEARD = "No speech was recognized.";
const NOT_RECOGNIZED = "Speech could not be recognized.";
/** After this many failed pieces in a row the engine is not waited on for
 *  the rest: each failure restarts it, and each wait can take minutes. */
const FAILURES_IN_A_ROW_LIMIT = 2;
/** A piece's language is kept for the rest only when it had this much text:
 *  a cough or "hmm" says little about the language she speaks. */
const LANGUAGE_MIN_LETTERS = 12;
const HINT_MS = 6_000;

interface Recording {
  stream: MediaStream;
  recorder?: SpeechRecorder;
  pieces: SpeechPieces;
  /** Recognized pieces, in order. */
  texts: string[];
  /** Pieces are recognized one after another, while she still speaks. */
  queue: Promise<void>;
  failure?: string;
  failuresInARow: number;
  /** Found in the first piece; the rest are recognized in the same language. */
  language?: string;
  /** Dropped (another chat, or the key turned out to be a shortcut): nothing
   *  more of it is sent to be recognized. */
  cancelled?: boolean;
}

/** One microphone, one dictation: the main field and a thread field never
 *  record the same speech twice. */
let dictationOwner: symbol | undefined;

/**
 * One dictation at a time in one message field: start records from the
 * microphone, stop recognizes what was said and hands the text over. A new
 * session (another chat or thread, the field going away) drops what is in
 * flight, so text never lands in a message it was not spoken for.
 */
export function useDictation(options: { session?: string; onText: (text: string) => void }): {
  phase: DictationPhase;
  seconds: number;
  notice?: DictationNotice;
  dismissNotice: () => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** Drops the recording without recognizing it, and stops recognizing one
   *  that has stopped. */
  cancel: () => void;
  /** Shows a passing note under the field. */
  hint: (text: string) => void;
} {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [notice, setNotice] = useState<DictationNotice>();
  const recordingRef = useRef<Recording>();
  /** The recording being recognized after it stopped. */
  const stoppingRef = useRef<Recording>();
  const generationRef = useRef(0);
  const ownerRef = useRef(Symbol("dictation"));
  const onTextRef = useRef(options.onText);
  onTextRef.current = options.onText;

  const release = useCallback(() => {
    if (dictationOwner === ownerRef.current) dictationOwner = undefined;
  }, []);

  const discard = useCallback(() => {
    generationRef.current += 1;
    const recording = recordingRef.current;
    recordingRef.current = undefined;
    if (recording) {
      recording.cancelled = true;
      void recording.recorder?.stop();
      stopTracks(recording.stream);
    }
    // What is still waiting to be recognized is not sent.
    if (stoppingRef.current) stoppingRef.current.cancelled = true;
    stoppingRef.current = undefined;
    release();
    setPhase("idle");
    setSeconds(0);
  }, [release]);

  useEffect(() => discard, [discard, options.session]);

  useEffect(() => {
    if (notice?.kind !== "hint") return undefined;
    const timer = window.setTimeout(() => setNotice(undefined), HINT_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const stop = useCallback(async () => {
    const recording = recordingRef.current;
    if (!recording) return;
    const generation = generationRef.current;
    recordingRef.current = undefined;
    stoppingRef.current = recording;
    setPhase("recognizing");
    try {
      await recording.recorder?.stop();
      stopTracks(recording.stream);
      // Only what was said since the last piece is still to recognize.
      const rest = recording.pieces.finish();
      if (rest.length) recognizePiece(recording, rest);
      await recording.queue;
      if (generation !== generationRef.current) return;
      const text = joinTranscripts(recording.texts);
      if (text) onTextRef.current(text);
      if (recording.failure) {
        setNotice({ text: text ? "Part of the recording could not be recognized." : recording.failure, kind: "error" });
      } else if (!text) {
        setNotice({ text: NOTHING_HEARD, kind: "hint" });
      }
    } catch (error) {
      if (generation !== generationRef.current) return;
      setNotice({ text: cleanIpcError(error) || NOT_RECOGNIZED, kind: "error" });
    } finally {
      if (stoppingRef.current === recording) stoppingRef.current = undefined;
      if (generation === generationRef.current) {
        release();
        setPhase("idle");
        setSeconds(0);
      }
    }
  }, [release]);

  // The time shown while recording; at the limit the recording stops and is
  // recognized, so nothing past it is lost.
  useEffect(() => {
    if (phase !== "recording") return undefined;
    const startedAt = Date.now();
    let lastPrepare = Date.now();
    const timer = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      setSeconds(elapsed);
      if (elapsed >= SPEECH_MAX_SECONDS) void stop();
      // A long recording keeps the model loaded: it leaves memory only
      // ten minutes after the last dictation, not during one.
      if (Date.now() - lastPrepare >= 60_000) {
        lastPrepare = Date.now();
        void window.consensus.prepareSpeechToText?.().catch(() => undefined);
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [phase, stop]);

  const start = useCallback(async () => {
    if (recordingRef.current) return;
    if (phase !== "idle") {
      if (phase === "recognizing") setNotice({ text: "Still recognizing the last dictation.", kind: "hint" });
      return;
    }
    if (dictationOwner && dictationOwner !== ownerRef.current) {
      setNotice({ text: "Another dictation is in progress.", kind: "hint" });
      return;
    }
    dictationOwner = ownerRef.current;
    const generation = ++generationRef.current;
    setNotice(undefined);
    setSeconds(0);
    setPhase("starting");
    let stream: MediaStream | undefined;
    try {
      const allowed = await window.consensus.requestMicrophoneAccess();
      if (generation !== generationRef.current) return;
      if (!allowed) {
        setNotice({ text: MICROPHONE_OFF, kind: "error" });
        release();
        setPhase("idle");
        return;
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      if (generation !== generationRef.current) {
        stopTracks(stream);
        return;
      }
      const recording: Recording = { stream, pieces: new SpeechPieces(), texts: [], queue: Promise.resolve(), failuresInARow: 0 };
      recording.recorder = await startSpeechRecorder({
        stream,
        onSamples: (samples) => {
          // A long recording is recognized piece by piece as she speaks.
          const piece = recording.pieces.push(samples);
          if (piece) recognizePiece(recording, piece);
        }
      });
      if (generation !== generationRef.current) {
        void recording.recorder.stop();
        stopTracks(stream);
        return;
      }
      // A microphone that goes away (unplugged, headset off) ends the
      // recording with what was said so far.
      for (const track of stream.getAudioTracks()) {
        track.onended = () => {
          if (recordingRef.current === recording) void stop();
        };
      }
      recordingRef.current = recording;
      setPhase("recording");
      // The model loads while she speaks, instead of after she stops.
      void window.consensus.prepareSpeechToText?.().catch(() => undefined);
    } catch (error) {
      if (stream) stopTracks(stream);
      if (generation !== generationRef.current) return;
      const name = error instanceof DOMException ? error.name : "";
      setNotice({
        text: name === "NotAllowedError" || name === "SecurityError"
          ? MICROPHONE_OFF
          : name === "NotFoundError"
            ? "No microphone was found."
            : "The microphone could not be started.",
        kind: "error"
      });
      discard();
    }
  }, [discard, phase, release, stop]);

  const hint = useCallback((text: string) => setNotice({ text, kind: "hint" }), []);
  return { phase, seconds, notice, dismissNotice: () => setNotice(undefined), start, stop, cancel: discard, hint };
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.onended = null;
    track.stop();
  }
}

/**
 * Queues one piece; each is given the end of the text before it and the
 * language of the first. A piece with no voice in it (a pause) is skipped,
 * and so is the rest once the engine has failed twice in a row.
 */
function recognizePiece(recording: Recording, samples: Float32Array): void {
  if (recording.cancelled || !speechHasVoice(samples)) return;
  const audio = encodeWavPcm16(samples);
  recording.queue = recording.queue.then(async () => {
    if (recording.cancelled || recording.failuresInARow >= FAILURES_IN_A_ROW_LIMIT) return;
    try {
      const prompt = speechPromptFrom(joinTranscripts(recording.texts));
      const result = await window.consensus.transcribeSpeech({
        audio,
        ...(prompt ? { prompt } : {}),
        ...(recording.language ? { language: recording.language } : {})
      });
      recording.texts.push(result.text);
      recording.failuresInARow = 0;
      if ((result.text.match(/\p{L}/gu)?.length ?? 0) >= LANGUAGE_MIN_LETTERS) recording.language ??= result.language;
    } catch (error) {
      recording.failuresInARow += 1;
      recording.failure ??= cleanIpcError(error) || NOT_RECOGNIZED;
    }
  });
}

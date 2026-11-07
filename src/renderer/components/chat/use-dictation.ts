import { useCallback, useEffect, useRef, useState } from "react";

import { SPEECH_MAX_SECONDS, SpeechPieces, encodeWavPcm16, joinTranscripts, speechPromptFrom } from "../../../shared/speechToText";
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
} {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [notice, setNotice] = useState<DictationNotice>();
  const recordingRef = useRef<Recording>();
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
      void recording.recorder?.stop();
      stopTracks(recording.stream);
    }
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
      setNotice({ text: cleanIpcError(error) || "Speech could not be recognized.", kind: "error" });
    } finally {
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
    if (recordingRef.current || phase !== "idle") return;
    if (dictationOwner && dictationOwner !== ownerRef.current) {
      setNotice({ text: "Another message field is already dictating.", kind: "hint" });
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
      const recording: Recording = { stream, pieces: new SpeechPieces(), texts: [], queue: Promise.resolve() };
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

  return { phase, seconds, notice, dismissNotice: () => setNotice(undefined), start, stop };
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.onended = null;
    track.stop();
  }
}

/** Queues one piece; each is given the end of the text before it. */
function recognizePiece(recording: Recording, samples: Float32Array): void {
  const audio = encodeWavPcm16(samples);
  recording.queue = recording.queue.then(async () => {
    try {
      const prompt = speechPromptFrom(joinTranscripts(recording.texts));
      const result = await window.consensus.transcribeSpeech({ audio, ...(prompt ? { prompt } : {}) });
      recording.texts.push(result.text);
    } catch (error) {
      recording.failure ??= cleanIpcError(error) || "Speech could not be recognized.";
    }
  });
}

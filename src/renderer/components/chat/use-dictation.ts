import { useCallback, useEffect, useRef, useState } from "react";

import { SPEECH_MAX_SECONDS, SPEECH_SAMPLE_RATE, encodeWavPcm16 } from "../../../shared/speechToText";
import { cleanIpcError } from "../../lib/ipc-error";

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
  recorder: MediaRecorder;
  chunks: Blob[];
  stopped: Promise<void>;
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
      if (recording.recorder.state !== "inactive") recording.recorder.stop();
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
      if (recording.recorder.state !== "inactive") recording.recorder.stop();
      await recording.stopped;
      stopTracks(recording.stream);
      const blob = new Blob(recording.chunks, { type: recording.recorder.mimeType || "audio/webm" });
      recording.chunks.length = 0;
      const samples = await decodeToSpeechSamples(blob).catch(() => undefined);
      if (generation !== generationRef.current) return;
      if (!samples || samples.length === 0) {
        setNotice({ text: NOTHING_HEARD, kind: "hint" });
        return;
      }
      const result = await window.consensus.transcribeSpeech({ audio: encodeWavPcm16(samples) });
      if (generation !== generationRef.current) return;
      if (result.text) onTextRef.current(result.text);
      else setNotice({ text: NOTHING_HEARD, kind: "hint" });
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
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : undefined;
      const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      // A microphone that goes away (unplugged, headset off) ends the
      // recording with what was said so far.
      for (const track of stream.getAudioTracks()) {
        track.onended = () => {
          if (recordingRef.current?.recorder === recorder) void stop();
        };
      }
      recorder.start(1_000);
      recordingRef.current = { stream, recorder, chunks, stopped };
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

/**
 * The recording as 16 kHz mono samples, the way the engine reads them. An
 * offline context at that rate resamples while decoding, so the recording is
 * never held at the microphone's own rate and no audio output is opened.
 */
async function decodeToSpeechSamples(blob: Blob): Promise<Float32Array> {
  const data = await blob.arrayBuffer();
  if (data.byteLength === 0) return new Float32Array(0);
  const decoded = await new OfflineAudioContext(1, 1, SPEECH_SAMPLE_RATE).decodeAudioData(data);
  if (decoded.numberOfChannels === 1) return decoded.getChannelData(0);
  const mono = new Float32Array(decoded.length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    const samples = decoded.getChannelData(channel);
    for (let index = 0; index < mono.length; index += 1) mono[index] += (samples[index] ?? 0) / decoded.numberOfChannels;
  }
  return mono;
}

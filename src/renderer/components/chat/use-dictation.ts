import { useCallback, useEffect, useRef, useState } from "react";

import { SPEECH_SAMPLE_RATE, encodeWavPcm16 } from "../../../shared/speechToText";

export type DictationPhase = "idle" | "starting" | "recording" | "recognizing";

const MICROPHONE_OFF =
  "Microphone access is off for AccordAgents. Turn it on in System Settings › Privacy & Security › Microphone.";

interface Recording {
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  stopped: Promise<void>;
}

/**
 * One dictation at a time in one message field: start records from the
 * microphone, stop recognizes what was said and hands the text over. A new
 * session (another chat, the field going away) drops what is in flight, so
 * text never lands in a message it was not spoken for.
 */
export function useDictation(options: { session?: string; onText: (text: string) => void }): {
  phase: DictationPhase;
  seconds: number;
  notice?: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [notice, setNotice] = useState<string>();
  const recordingRef = useRef<Recording>();
  const generationRef = useRef(0);
  const onTextRef = useRef(options.onText);
  onTextRef.current = options.onText;

  const discard = useCallback(() => {
    generationRef.current += 1;
    const recording = recordingRef.current;
    recordingRef.current = undefined;
    if (recording) {
      if (recording.recorder.state !== "inactive") recording.recorder.stop();
      for (const track of recording.stream.getTracks()) track.stop();
    }
    setPhase("idle");
    setSeconds(0);
  }, []);

  useEffect(() => discard, [discard, options.session]);

  useEffect(() => {
    if (phase !== "recording") return undefined;
    const startedAt = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 250);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(undefined), 8_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const start = useCallback(async () => {
    if (recordingRef.current || phase !== "idle") return;
    const generation = ++generationRef.current;
    setNotice(undefined);
    setSeconds(0);
    setPhase("starting");
    try {
      const allowed = await window.consensus.requestMicrophoneAccess();
      if (generation !== generationRef.current) return;
      if (!allowed) {
        setNotice(MICROPHONE_OFF);
        setPhase("idle");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      if (generation !== generationRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : undefined;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      recorder.start(1_000);
      recordingRef.current = { stream, recorder, chunks, stopped };
      setPhase("recording");
    } catch (error) {
      if (generation !== generationRef.current) return;
      const name = error instanceof DOMException ? error.name : "";
      setNotice(name === "NotAllowedError" || name === "SecurityError"
        ? MICROPHONE_OFF
        : name === "NotFoundError"
          ? "No microphone was found."
          : "The microphone could not be started.");
      discard();
    }
  }, [discard, phase]);

  const stop = useCallback(async () => {
    const recording = recordingRef.current;
    if (!recording) return;
    const generation = generationRef.current;
    recordingRef.current = undefined;
    setPhase("recognizing");
    try {
      if (recording.recorder.state !== "inactive") recording.recorder.stop();
      await recording.stopped;
      for (const track of recording.stream.getTracks()) track.stop();
      const blob = new Blob(recording.chunks, { type: recording.recorder.mimeType || "audio/webm" });
      const samples = await decodeToSpeechSamples(blob);
      if (generation !== generationRef.current) return;
      const result = await window.consensus.transcribeSpeech({ audio: encodeWavPcm16(samples) });
      if (generation !== generationRef.current) return;
      if (result.text) onTextRef.current(result.text);
      else setNotice("No speech was recognized.");
    } catch (error) {
      if (generation !== generationRef.current) return;
      setNotice(cleanIpcError(error));
    } finally {
      if (generation === generationRef.current) {
        setPhase("idle");
        setSeconds(0);
      }
    }
  }, []);

  return { phase, seconds, notice, start, stop };
}

/** The recording as 16 kHz mono samples, the way the engine reads them. */
async function decodeToSpeechSamples(blob: Blob): Promise<Float32Array> {
  const data = await blob.arrayBuffer();
  if (data.byteLength === 0) return new Float32Array(0);
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(data);
  } finally {
    void context.close();
  }
  const length = Math.max(1, Math.ceil(decoded.duration * SPEECH_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, length, SPEECH_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

/** Electron prefixes errors from the main process with where they came from. */
function cleanIpcError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") || "Speech could not be recognized.";
}

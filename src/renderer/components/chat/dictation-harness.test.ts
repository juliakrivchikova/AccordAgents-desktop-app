import type { SpeechToTextState, TranscribeSpeechResult } from "../../../shared/types";

/** Stand-ins for the bridge, the microphone and the audio graph in dictation tests. */
export interface FakeTrack { stopped: boolean; stop: () => void; onended: (() => void) | null }

export interface Fakes {
  prepared: number;
  allowMicrophone: boolean;
  failRecorder: boolean;
  tracks: FakeTrack[];
  transcribe: Array<{ resolve: (result: TranscribeSpeechResult) => void }>;
}

/** One second of speech-like sound, as the recorder hands it over. */
const SECOND_OF_SOUND = new Float32Array(16_000).map((_, index) => 0.2 * Math.sin(index / 5));

export function installFakes(state: SpeechToTextState): Fakes {
  const fakes: Fakes = { prepared: 0, allowMicrophone: true, failRecorder: false, tracks: [], transcribe: [] };
  (globalThis as unknown as { window: { consensus: unknown } }).window.consensus = {
    getSpeechToTextState: async () => state,
    onSpeechToTextState: () => () => undefined,
    requestMicrophoneAccess: async () => fakes.allowMicrophone,
    prepareSpeechToText: async () => { fakes.prepared += 1; },
    transcribeSpeech: () => new Promise<TranscribeSpeechResult>((resolve) => fakes.transcribe.push({ resolve }))
  };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        const track: FakeTrack = { stopped: false, onended: null, stop() { this.stopped = true; } };
        fakes.tracks.push(track);
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      }
    }
  });
  const node = { connect: () => undefined, disconnect: () => undefined };
  class FakeAudioContext {
    state = "running";
    destination = {};
    audioWorklet = { addModule: async () => undefined };
    createMediaStreamSource(): unknown { return node; }
    createGain(): unknown { return { gain: { value: 1 }, connect: () => undefined }; }
    async resume(): Promise<void> {}
    async close(): Promise<void> {}
  }
  // The recorder's tap: when the recording stops, it hands over a second of sound.
  class FakeTapNode {
    port = {
      onmessage: null as ((event: { data: { samples: Float32Array; last: boolean } }) => void) | null,
      postMessage: (message: unknown) => {
        if (message === "flush") setTimeout(() => this.port.onmessage?.({ data: { samples: SECOND_OF_SOUND, last: true } }), 0);
      }
    };
    constructor() {
      if (fakes.failRecorder) throw new Error("recorder refused");
    }
    connect(): void {}
    disconnect(): void {}
  }
  Object.assign(globalThis, { AudioContext: FakeAudioContext, AudioWorkletNode: FakeTapNode });
  return fakes;
}

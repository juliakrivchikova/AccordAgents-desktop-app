import type { SpeechToTextState, TranscribeSpeechRequest, TranscribeSpeechResult } from "../../../shared/types";

/** Stand-ins for the bridge, the microphone and the audio graph in dictation tests. */
export interface FakeTrack { stopped: boolean; stop: () => void; onended: (() => void) | null }

export interface Fakes {
  prepared: number;
  allowMicrophone: boolean;
  /** When set, the system's microphone answer waits for `answerMicrophone`. */
  holdMicrophone: boolean;
  answerMicrophone: () => void;
  failRecorder: boolean;
  tracks: FakeTrack[];
  transcribe: Array<{
    request: TranscribeSpeechRequest;
    resolve: (result: TranscribeSpeechResult) => void;
    reject: (error: Error) => void;
  }>;
  /** Hands the running recording this many seconds of speech, as the
   *  microphone would while she talks. */
  speak: (seconds: number) => void;
}

/** One second of speech-like sound, as the recorder hands it over. */
const SECOND_OF_SOUND = new Float32Array(16_000).map((_, index) => 0.2 * Math.sin(index / 5));

export function installFakes(state: SpeechToTextState): Fakes {
  let tap: FakeTapNode | undefined;
  const microphoneWaits: Array<() => void> = [];
  const fakes: Fakes = {
    prepared: 0,
    allowMicrophone: true,
    holdMicrophone: false,
    answerMicrophone: () => microphoneWaits.shift()?.(),
    failRecorder: false,
    tracks: [],
    transcribe: [],
    speak: (seconds) => {
      for (let second = 0; second < seconds; second += 1) {
        tap?.port.onmessage?.({ data: { samples: SECOND_OF_SOUND, last: false } });
      }
    }
  };
  (globalThis as unknown as { window: { consensus: unknown } }).window.consensus = {
    getSpeechToTextState: async () => state,
    onSpeechToTextState: () => () => undefined,
    requestMicrophoneAccess: () => fakes.holdMicrophone
      ? new Promise<boolean>((resolve) => microphoneWaits.push(() => resolve(fakes.allowMicrophone)))
      : Promise.resolve(fakes.allowMicrophone),
    prepareSpeechToText: async () => { fakes.prepared += 1; },
    transcribeSpeech: (request: TranscribeSpeechRequest) =>
      new Promise<TranscribeSpeechResult>((resolve, reject) => fakes.transcribe.push({ request, resolve, reject }))
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
      tap = this;
    }
    connect(): void {}
    disconnect(): void {}
  }
  Object.assign(globalThis, { AudioContext: FakeAudioContext, AudioWorkletNode: FakeTapNode });
  return fakes;
}

import { SPEECH_SAMPLE_RATE } from "../../../shared/speechToText";

/**
 * Hands the microphone's sound to the page in batches of 100 ms. It runs on
 * the audio thread, so recording never waits on the page.
 */
const TAP_SOURCE = `
class AccordAgentsSpeechTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(${SPEECH_SAMPLE_RATE / 10});
    this.filled = 0;
    this.port.onmessage = () => {
      this.port.postMessage({ samples: this.batch.slice(0, this.filled), last: true });
      this.filled = 0;
    };
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let read = 0;
    while (read < channel.length) {
      const count = Math.min(channel.length - read, this.batch.length - this.filled);
      this.batch.set(channel.subarray(read, read + count), this.filled);
      this.filled += count;
      read += count;
      if (this.filled === this.batch.length) {
        this.port.postMessage({ samples: this.batch.slice(0), last: false });
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor("accordagents-speech-tap", AccordAgentsSpeechTap);
`;

let tapModuleUrl: string | undefined;

export interface SpeechRecorder {
  /** Ends recording; resolves once the last sound has been handed over. */
  stop(): Promise<void>;
}

/**
 * Records the microphone as 16 kHz mono samples, the way the engine reads
 * them, and hands them over as they come. The audio context resamples the
 * microphone itself, so nothing is decoded or resampled afterwards.
 */
export async function startSpeechRecorder(options: {
  stream: MediaStream;
  onSamples: (samples: Float32Array) => void;
}): Promise<SpeechRecorder> {
  const context = new AudioContext({ sampleRate: SPEECH_SAMPLE_RATE });
  try {
    tapModuleUrl ??= URL.createObjectURL(new Blob([TAP_SOURCE], { type: "text/javascript" }));
    await context.audioWorklet.addModule(tapModuleUrl);
    const source = context.createMediaStreamSource(options.stream);
    const tap = new AudioWorkletNode(context, "accordagents-speech-tap", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    // A node is run only when it leads somewhere: a silent output does that.
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(tap);
    tap.connect(mute);
    mute.connect(context.destination);
    let flushed: (() => void) | undefined;
    tap.port.onmessage = (event: MessageEvent<{ samples: Float32Array; last: boolean }>) => {
      if (event.data.samples.length) options.onSamples(event.data.samples);
      if (event.data.last) flushed?.();
    };
    if (context.state === "suspended") await context.resume();
    let stopping: Promise<void> | undefined;
    return {
      stop: () => {
        stopping ??= (async () => {
          await new Promise<void>((resolve) => {
            flushed = resolve;
            tap.port.postMessage("flush");
            // A context that stopped running never answers.
            window.setTimeout(resolve, 500);
          });
          source.disconnect();
          tap.disconnect();
          tap.port.onmessage = null;
          await context.close().catch(() => undefined);
        })();
        return stopping;
      }
    };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

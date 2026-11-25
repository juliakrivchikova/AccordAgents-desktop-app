/**
 * Speech to text on this computer.
 * - unavailable: this build or this computer cannot run it.
 * - off: the User has not turned it on (the model may still be on disk).
 * - downloading / verifying: the model is being fetched or checked.
 * - interrupted: turned on, but the model is incomplete and nothing is
 *   downloading (a failed download, or the app quit during one).
 * - ready: the microphone can be used.
 */
export type SpeechToTextStatus = "unavailable" | "off" | "downloading" | "verifying" | "interrupted" | "ready";

export interface SpeechToTextState {
  status: SpeechToTextStatus;
  /** The model is fully downloaded and checked, whether or not it is on. */
  modelInstalled: boolean;
  downloadedBytes: number;
  totalBytes: number;
  /** What went wrong, in a sentence for the User. */
  error?: string;
  /** The key held to dictate while the app is in front. */
  holdKey: import("../speechToText").SpeechHoldKey;
}

export interface DisableSpeechToTextRequest {
  deleteModel: boolean;
}

export interface TranscribeSpeechRequest {
  /** A 16 kHz mono 16-bit PCM WAV file. */
  audio: Uint8Array;
  /** The end of the text recognized before this piece of a long recording. */
  prompt?: string;
  /** The language found in the recording's first piece, kept for the rest. */
  language?: string;
}

export interface TranscribeSpeechResult {
  text: string;
  /** The language the engine heard, in its own naming ("russian"). */
  language?: string;
}

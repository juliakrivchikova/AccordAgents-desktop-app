import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { SpeechToTextState, TranscribeSpeechResult } from "../../../shared/types";
import { SpeechToTextButton } from "./speech-to-text-button";

assert.ok(
  (globalThis as unknown as { ACCORD_RENDERER_JSDOM?: boolean }).ACCORD_RENDERER_JSDOM,
  "this test needs a DOM installed before its imports — run it via `npm run test:renderer-components`"
);

const READY: SpeechToTextState = { status: "ready", modelInstalled: true, downloadedBytes: 1, totalBytes: 1 };

interface FakeTrack { stopped: boolean; stop: () => void; onended: (() => void) | null }

interface Fakes {
  prepared: number;
  allowMicrophone: boolean;
  failRecorder: boolean;
  tracks: FakeTrack[];
  transcribe: Array<{ resolve: (result: TranscribeSpeechResult) => void }>;
}

function installFakes(): Fakes {
  const fakes: Fakes = { prepared: 0, allowMicrophone: true, failRecorder: false, tracks: [], transcribe: [] };
  (globalThis as unknown as { window: { consensus: unknown } }).window.consensus = {
    getSpeechToTextState: async () => READY,
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
  class FakeRecorder {
    static isTypeSupported(): boolean { return true; }
    state = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor() {
      if (fakes.failRecorder) throw new Error("recorder refused");
    }
    start(): void { this.state = "recording"; }
    stop(): void {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob([new Uint8Array(64)]) });
      this.onstop?.();
    }
  }
  class FakeOfflineContext {
    async decodeAudioData(): Promise<unknown> {
      const samples = new Float32Array(16_000).map((_, index) => 0.2 * Math.sin(index / 5));
      return { numberOfChannels: 1, length: samples.length, getChannelData: () => samples };
    }
  }
  Object.assign(globalThis, { MediaRecorder: FakeRecorder, OfflineAudioContext: FakeOfflineContext });
  return fakes;
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

function field(): HTMLTextAreaElement {
  const textarea = document.createElement("textarea");
  document.body.append(textarea);
  return textarea;
}

async function mount(props: { session: string; textarea: HTMLTextAreaElement; drafts: string[] }): Promise<{
  root: Root;
  host: HTMLElement;
  rerender: (session: string) => Promise<void>;
}> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = async (session: string): Promise<void> => {
    await act(async () => {
      root.render(
        <SpeechToTextButton
          session={session}
          getTextarea={() => props.textarea}
          draft={props.textarea.value}
          onDraftChange={(value) => {
            props.drafts.push(value);
            props.textarea.value = value;
          }}
        />
      );
    });
    await settle();
  };
  await render(props.session);
  return { root, host, rerender: render };
}

function click(host: HTMLElement, testId: string): Promise<void> {
  const button = host.querySelector(`[data-testid=${testId}]`) as HTMLButtonElement | null;
  assert.ok(button, `${testId} is on screen`);
  return act(async () => { button.click(); });
}

test("recognized text goes in at the caret and nothing is sent", async () => {
  const fakes = installFakes();
  const textarea = field();
  textarea.value = "Start. End.";
  textarea.setSelectionRange(6, 6);
  const drafts: string[] = [];
  const view = await mount({ session: "chat-1", textarea, drafts });
  try {
    await click(view.host, "composer-dictation-start");
    await settle();
    assert.equal(fakes.prepared, 1, "the model starts loading as she starts speaking");
    await click(view.host, "composer-dictation-stop");
    await settle();
    assert.equal(fakes.tracks[0]?.stopped, true, "the microphone is released when the recording stops");
    fakes.transcribe[0]!.resolve({ text: "Привет, мир." });
    await settle();
    assert.deepEqual(drafts, ["Start. Привет, мир. End."]);
  } finally {
    await act(async () => { view.root.unmount(); });
    view.host.remove();
    textarea.remove();
  }
});

test("text spoken in one thread never lands in the thread opened while it was recognized", async () => {
  const fakes = installFakes();
  const textarea = field();
  const drafts: string[] = [];
  const view = await mount({ session: "chat-1:thread-a", textarea, drafts });
  try {
    await click(view.host, "composer-dictation-start");
    await settle();
    await click(view.host, "composer-dictation-stop");
    await settle();
    await view.rerender("chat-1:thread-b");
    fakes.transcribe[0]!.resolve({ text: "for thread A" });
    await settle();
    assert.deepEqual(drafts, []);
    assert.ok(view.host.querySelector("[data-testid=composer-dictation-start]"), "the microphone is ready again");
  } finally {
    await act(async () => { view.root.unmount(); });
    view.host.remove();
    textarea.remove();
  }
});

test("a refused microphone says where to turn it on", async () => {
  const fakes = installFakes();
  fakes.allowMicrophone = false;
  const textarea = field();
  const view = await mount({ session: "chat-1", textarea, drafts: [] });
  try {
    await click(view.host, "composer-dictation-start");
    await settle();
    assert.match(view.host.querySelector("[data-testid=composer-dictation-notice]")?.textContent ?? "", /System Settings/);
    assert.equal(fakes.tracks.length, 0);
  } finally {
    await act(async () => { view.root.unmount(); });
    view.host.remove();
    textarea.remove();
  }
});

test("a recorder that cannot start releases the microphone", async () => {
  const fakes = installFakes();
  fakes.failRecorder = true;
  const textarea = field();
  const view = await mount({ session: "chat-1", textarea, drafts: [] });
  try {
    await click(view.host, "composer-dictation-start");
    await settle();
    assert.equal(fakes.tracks[0]?.stopped, true);
    assert.match(view.host.querySelector("[data-testid=composer-dictation-notice]")?.textContent ?? "", /could not be started/);
  } finally {
    await act(async () => { view.root.unmount(); });
    view.host.remove();
    textarea.remove();
  }
});

test("only one message field dictates at a time", async () => {
  const fakes = installFakes();
  const first = field();
  const second = field();
  const a = await mount({ session: "chat-1", textarea: first, drafts: [] });
  const b = await mount({ session: "chat-1:thread", textarea: second, drafts: [] });
  try {
    await click(a.host, "composer-dictation-start");
    await settle();
    await click(b.host, "composer-dictation-start");
    await settle();
    assert.equal(fakes.tracks.length, 1);
    assert.match(b.host.querySelector("[data-testid=composer-dictation-notice]")?.textContent ?? "", /already dictating/);
    await click(a.host, "composer-dictation-stop");
    await settle();
    fakes.transcribe[0]!.resolve({ text: "" });
    await settle();
    await click(b.host, "composer-dictation-start");
    await settle();
    assert.equal(fakes.tracks.length, 2, "the other field can dictate once the first is done");
  } finally {
    await act(async () => { a.root.unmount(); b.root.unmount(); });
    a.host.remove();
    b.host.remove();
    first.remove();
    second.remove();
  }
});

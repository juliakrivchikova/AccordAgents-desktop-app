import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SPEECH_HOLD_KEYS, SPEECH_HOLD_KEY_LABELS, formatSpeechBytes, isSpeechHoldKey } from "../../../shared/speechToText";
import type { SpeechToTextState } from "../../../shared/types";
import { useSpeechToTextState } from "../../app/use-speech-to-text";
import { cleanIpcError } from "../../lib/ipc-error";
import { isWindowsPlatform } from "../../lib/platform";
import { AppSelect } from "../primitives";
import { AwsDialog } from "./aws-dialog";

const HOLD_KEY_OPTIONS = SPEECH_HOLD_KEYS.map((value) => ({ value, label: SPEECH_HOLD_KEY_LABELS[value] }));

type Dialog = "download" | "turn-off" | undefined;

/**
 * Speech to text in General: a switch that downloads the model once she
 * agrees to the download, shows its progress, and on the way off asks
 * whether to keep the model for next time.
 */
export function SpeechToTextRow(): JSX.Element | null {
  const state = useSpeechToTextState();
  const [dialog, setDialog] = useState<Dialog>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  if (isWindowsPlatform() || !state) {
    return null;
  }

  async function act(action: () => Promise<SpeechToTextState>): Promise<void> {
    setPending(true);
    setError(undefined);
    try {
      await action();
      setDialog(undefined);
    } catch (caught) {
      setError(cleanIpcError(caught));
    } finally {
      setPending(false);
    }
  }

  const on = state.status === "downloading" || state.status === "verifying" || state.status === "interrupted" || state.status === "ready";
  const size = formatSpeechBytes(state.totalBytes);
  const toggle = (next: boolean): void => {
    if (next) {
      if (state.modelInstalled) void act(() => window.consensus.enableSpeechToText());
      else setDialog("download");
      return;
    }
    if (state.status === "ready") setDialog("turn-off");
    else void act(() => window.consensus.cancelSpeechToTextDownload());
  };

  return (
    <>
      <div className="gen-card-divider" />
      <div className="gen-row" data-testid="speech-to-text-row">
        <div className="gen-row-text">
          <div className="gen-row-title">Speech to text</div>
          <div className="gen-row-desc" data-testid="speech-to-text-status">{describe(state, size)}</div>
          {state.status === "downloading" || state.status === "verifying" ? (
            <div
              className="gen-speech-progress"
              role="progressbar"
              aria-label="Speech model download"
              aria-valuemin={0}
              aria-valuemax={state.totalBytes}
              aria-valuenow={state.downloadedBytes}
            >
              <span style={{ width: `${percent(state)}%` }} />
            </div>
          ) : null}
          {state.status === "interrupted" && state.error ? (
            <div className="gen-row-error" role="alert" data-testid="speech-to-text-error">{state.error}</div>
          ) : null}
          {error ? <div className="gen-row-error" role="alert">{error}</div> : null}
          {state.status === "downloading" || state.status === "interrupted" ? (
            <div className="gen-speech-actions">
              {state.status === "interrupted" ? (
                <Button type="button" variant="outline" size="sm" disabled={pending} data-testid="speech-to-text-resume"
                  onClick={() => void act(() => window.consensus.enableSpeechToText())}>
                  Resume download
                </Button>
              ) : null}
              <Button type="button" variant="outline" size="sm" disabled={pending} data-testid="speech-to-text-cancel"
                onClick={() => void act(() => window.consensus.cancelSpeechToTextDownload())}>
                Cancel download
              </Button>
            </div>
          ) : null}
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            data-testid="speech-to-text-toggle"
            aria-label="Speech to text"
            checked={on}
            disabled={pending || state.status === "unavailable" || state.status === "verifying"}
            onChange={(event) => toggle(event.target.checked)}
          />
          <span />
        </label>
      </div>
      {state.status !== "unavailable" ? (
        <>
          <div className="gen-card-divider" />
          <div className="gen-row" data-testid="speech-to-text-hold-key-row">
            <div className="gen-row-text">
              <div className="gen-row-title">Hold to dictate</div>
              <div className="gen-row-desc">
                While AccordAgents is in front, hold this key and speak; release it to put the text where the cursor is.
              </div>
            </div>
            <AppSelect
              value={state.holdKey}
              options={HOLD_KEY_OPTIONS}
              placeholder="Key"
              ariaLabel="Key to hold to dictate"
              testId="speech-to-text-hold-key"
              size="sm"
              disabled={pending}
              onValueChange={(value) => {
                if (isSpeechHoldKey(value)) void act(() => window.consensus.setSpeechToTextHoldKey(value));
              }}
            />
          </div>
        </>
      ) : null}
      <AwsDialog
        open={dialog === "download"}
        title="Download the speech model?"
        testId="speech-to-text-download-dialog"
        busy={pending}
        onClose={() => setDialog(undefined)}
        description={`Speech to text recognizes speech on this Mac with Whisper, OpenAI's open speech model, in English, Russian and many other languages. The model is a one-time ${size} download; after that, your recordings never leave this Mac.`}
        actions={<>
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setDialog(undefined)}>Cancel</Button>
          <Button type="button" size="sm" disabled={pending} data-testid="speech-to-text-download-confirm"
            onClick={() => void act(() => window.consensus.enableSpeechToText())}>
            {pending ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null}
            Download and install
          </Button>
        </>}
      />
      <AwsDialog
        open={dialog === "turn-off"}
        title="Turn off speech to text?"
        testId="speech-to-text-off-dialog"
        busy={pending}
        onClose={() => setDialog(undefined)}
        description={`The speech model takes ${size} on this Mac. Keep it to turn speech to text back on without downloading it again, or delete it to free the space.`}
        actions={<>
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setDialog(undefined)}>Cancel</Button>
          <Button type="button" variant="outline" size="sm" disabled={pending} data-testid="speech-to-text-off-keep"
            onClick={() => void act(() => window.consensus.disableSpeechToText({ deleteModel: false }))}>
            Turn off, keep model
          </Button>
          <Button type="button" variant="destructive" size="sm" disabled={pending} data-testid="speech-to-text-off-delete"
            onClick={() => void act(() => window.consensus.disableSpeechToText({ deleteModel: true }))}>
            Turn off and delete model
          </Button>
        </>}
      />
    </>
  );
}

function percent(state: SpeechToTextState): number {
  if (state.status === "verifying" || state.totalBytes <= 0) return 100;
  return Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 100));
}

function describe(state: SpeechToTextState, size: string): string {
  switch (state.status) {
    case "unavailable":
      return state.error ?? "Speech to text is not available on this computer.";
    case "downloading":
      return `Downloading the speech model: ${formatSpeechBytes(state.downloadedBytes)} of ${size}.`;
    case "verifying":
      return "Checking the downloaded model…";
    case "interrupted":
      return `The speech model is not fully downloaded (${formatSpeechBytes(state.downloadedBytes)} of ${size}).`;
    case "ready":
      return "On. Press the microphone in the message field to dictate; speech is recognized on this Mac.";
    case "off":
      return state.modelInstalled
        ? "Dictate messages with the microphone. The speech model is already on this Mac."
        : `Dictate messages with the microphone, in any language. Recognized on this Mac; needs a one-time ${size} download.`;
  }
}

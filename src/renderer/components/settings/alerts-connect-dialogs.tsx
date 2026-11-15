import { Check, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { UrgentAlertSettingsView } from "../../../shared/urgentAlerts";
import { CopyButton } from "../primitives";
import { AlertsStep, alertRequest, useSettingsWatch } from "./alerts-shared";
import { AwsDialog } from "./aws-dialog";

/** How long Start may take before "Nothing yet?" offers the link again. */
const START_HELP_MS = 30_000;

/**
 * Connect Telegram, as the User approved it on 2026-11-15: the User's own
 * bot (BotFather's steps spelled out, the token hidden), Start in the bot,
 * then Got it on a test message. Each step is read back from the server,
 * which does it. While it waits, closing loses nothing: the bot is saved.
 */
export function TelegramConnectDialog(props: {
  open: boolean;
  settings?: UrgentAlertSettingsView;
  onSettings: (settings: UrgentAlertSettingsView) => void;
  onClose: () => void;
}): JSX.Element {
  const telegram = props.settings?.telegram;
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [startHelp, setStartHelp] = useState(false);
  const tokenField = useRef<HTMLInputElement>(null);
  const openBotButton = useRef<HTMLButtonElement>(null);
  const step = !telegram || telegram.error ? 1 : telegram.connected ? 4 : telegram.step === "test" ? 3 : 2;
  const { onSettings } = props;
  useSettingsWatch(props.open && (step === 2 || step === 3), onSettings);

  useEffect(() => {
    if (!props.open) {
      setToken("");
      setShowToken(false);
      setError(undefined);
    }
  }, [props.open]);

  useEffect(() => {
    setStartHelp(false);
    if (!props.open || step !== 2) return undefined;
    const timer = setTimeout(() => setStartHelp(true), START_HELP_MS);
    return () => clearTimeout(timer);
  }, [props.open, step]);

  async function connect(): Promise<void> {
    setBusy(true);
    setError(undefined);
    const result = await alertRequest<UrgentAlertSettingsView>({ action: "telegram.connect", token });
    setBusy(false);
    if (!result.ok) return setError(result.error.message);
    setToken("");
    props.onSettings(result.value);
    // The field is gone: the next thing to press takes the focus.
    setTimeout(() => openBotButton.current?.focus(), 0);
  }

  /** Another bot: the saved one is dropped and the first step comes back. */
  async function differentBot(): Promise<void> {
    setBusy(true);
    setError(undefined);
    const result = await alertRequest<UrgentAlertSettingsView>({ action: "telegram.disconnect" });
    setBusy(false);
    if (!result.ok) return setError(result.error.message);
    props.onSettings(result.value);
    setTimeout(() => tokenField.current?.focus(), 0);
  }

  const bot = telegram?.botUsername ? `@${telegram.botUsername}` : "your bot";
  const openStart = () => void window.consensus.openExternal(`https://t.me/${telegram?.botUsername ?? ""}${telegram?.startCode ? `?start=${encodeURIComponent(telegram.startCode)}` : ""}`);
  const fieldError = step === 1 ? (error ?? telegram?.error) : undefined;
  return (
    <AwsDialog
      open={props.open}
      title="Connect Telegram"
      description="About 3 minutes. Your own bot sends you each alert."
      busy={busy}
      testId="alerts-telegram-dialog"
      className="alerts-dialog"
      initialFocus={() => tokenField.current ?? openBotButton.current}
      onClose={props.onClose}
      note={step === 2 || step === 3 ? "Your bot is saved. Finish any time from Settings → Alerts." : undefined}
      actions={step === 4
        ? <Button type="button" size="sm" onClick={props.onClose} data-testid="alerts-telegram-done">Done</Button>
        : step === 1
          ? <>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={props.onClose}>Cancel</Button>
            <Button type="button" size="sm" disabled={busy || !token.trim()} onClick={() => void connect()} data-testid="alerts-telegram-continue">
              {busy ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null}Continue
            </Button>
          </>
          : <Button type="button" variant="outline" size="sm" disabled={busy} onClick={props.onClose} data-testid="alerts-telegram-close">Close</Button>}
    >
      <div className="alerts-dialog-body">
      <ol className="alerts-steps">
        <AlertsStep n={1} state={step > 1 ? "done" : "now"} title={step > 1 ? <>Bot {bot}{step < 4 ? (
          <button type="button" className="alerts-text-button" disabled={busy} onClick={() => void differentBot()} data-testid="alerts-telegram-different">Use a different bot</button>
        ) : null}</> : "Create your bot"}>
          {step === 1 ? <>
            <div className="alerts-step-actions">
              <Button type="button" variant="outline" size="sm" onClick={() => void window.consensus.openExternal("https://t.me/BotFather")}>
                <ExternalLink size={13} aria-hidden /> Open BotFather
              </Button>
            </div>
            <ol className="alerts-howto">
              <li>Send <code>/newbot</code> <CopyButton text="/newbot" label="Copy /newbot" size="xs" /></li>
              <li>Name: anything. Username: must end in <b>bot</b>, like alerts_for_me_bot.</li>
              <li>Copy the token it sends you.</li>
            </ol>
            <div className="alerts-field">
              <label htmlFor="alerts-telegram-token">Bot token</label>
              <span className="alerts-secret">
                <input
                  ref={tokenField}
                  id="alerts-telegram-token"
                  className="gen-input alerts-input"
                  type={showToken ? "text" : "password"}
                  value={token}
                  placeholder="123456789:AAH…"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={fieldError ? true : undefined}
                  aria-describedby="alerts-telegram-token-hint"
                  data-testid="alerts-telegram-token"
                  onChange={(event) => setToken(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter" && token.trim() && !busy) void connect(); }}
                />
                <button type="button" className="alerts-show" aria-label="Show token" aria-pressed={showToken} onClick={() => setShowToken((shown) => !shown)}>
                  {showToken ? "Hide" : "Show"}
                </button>
              </span>
            </div>
            {fieldError
              ? <div className="gen-row-error" role="alert" id="alerts-telegram-token-hint">{fieldError}</div>
              : <div className="alerts-hint" id="alerts-telegram-token-hint">Kept on your server only.</div>}
          </> : null}
        </AlertsStep>
        <AlertsStep n={2} state={step > 2 ? "done" : step === 2 ? "now" : "later"} title="Press Start in your bot">
          {step === 2 ? <>
            <div className="alerts-step-actions">
              <Button ref={openBotButton} type="button" size="sm" onClick={openStart} data-testid="alerts-telegram-open-bot">
                <ExternalLink size={13} aria-hidden /> Open {bot}
              </Button>
            </div>
            <div className="alerts-step-detail">In the chat, press <b>Start</b> at the bottom. The button opens your bot with a one-time code, so only your Start connects it.</div>
            <div className="alerts-waiting" role="status"><Loader2 size={13} className="gen-aws-spinner" aria-hidden /> Waiting for Start…</div>
            {startHelp ? <div className="alerts-step-detail">Nothing yet? <button type="button" className="alerts-text-button" onClick={openStart}>Open it again</button></div> : null}
          </> : null}
        </AlertsStep>
        <AlertsStep n={3} state={step > 3 ? "done" : step === 3 ? "now" : "later"} title="Press Got it on a test message">
          {step === 3 ? <>
            <div className="alerts-step-detail">A test message with a Got it button is in your Telegram. Press Got it on it.</div>
            <div className="alerts-waiting" role="status"><Loader2 size={13} className="gen-aws-spinner" aria-hidden /> Waiting for Got it…</div>
          </> : null}
          {step === 4 ? <div className="alerts-done-line" role="status"><Check size={13} aria-hidden /> Connected{telegram?.chatName ? ` to ${telegram.chatName}` : ""}</div> : null}
        </AlertsStep>
      </ol>
      {step !== 1 && error ? <div className="gen-row-error" role="alert">{error}</div> : null}
      </div>
    </AwsDialog>
  );
}

import { CheckIcon, ArrowSquareOutIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { UrgentAlertSettingsView } from "../../../shared/urgentAlerts";
import { CopyButton } from "../primitives";
import { AlertsWizard, alertRequest, useSettingsWatch } from "./alerts-shared";
import { Spinner } from "@/components/ui/spinner";
import { Delayed } from "@/components/ui/delayed";

/** How long Start may take before "Nothing yet?" offers the link again. */
const START_HELP_MS = 30_000;
const TELEGRAM_STEPS = ["Your bot", "Start", "Got it"] as const;

/**
 * Connect Telegram one step at a time, as the User approved it on 2026-11-16:
 * her own bot (BotFather's steps spelled out, the token hidden), Start in the
 * bot, then Got it on a test message. Each step is read back from the server,
 * which does it, so Start and Got it move the dialog on by themselves. While
 * it waits, closing loses nothing: the bot is saved.
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
  const serverStep = !telegram || telegram.error ? 0 : telegram.connected ? 3 : telegram.step === "test" ? 2 : 1;
  const step = serverStep;
  const { onSettings } = props;
  useSettingsWatch(props.open && (serverStep === 1 || serverStep === 2), onSettings);

  useEffect(() => {
    if (!props.open) {
      setToken("");
      setShowToken(false);
      setError(undefined);
    }
  }, [props.open]);

  // What went wrong belongs to the step it happened on.
  useEffect(() => setError(undefined), [serverStep]);

  useEffect(() => {
    setStartHelp(false);
    if (!props.open || step !== 1) return undefined;
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
  }

  /** Back to the first step: the bot waiting for Start is dropped, another
   *  token is asked for. */
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
  const fieldError = step === 0 ? (error ?? telegram?.error) : undefined;
  const finishLater = <Button type="button" variant="outline" size="sm" disabled={busy} onClick={props.onClose} data-testid="alerts-telegram-close">Finish later</Button>;
  return (
    <AlertsWizard
      open={props.open}
      title="Connect Telegram"
      steps={TELEGRAM_STEPS}
      current={step}
      busy={busy}
      testId="alerts-telegram-dialog"
      initialFocus={() => tokenField.current ?? openBotButton.current}
      focusKey={String(step)}
      onClose={props.onClose}
      // Back from Start drops the bot waiting for it. Once Start came, the bot
      // has her chat: no Back that could drop it (Use a different bot is on
      // the page's menu, with a confirmation).
      onBack={step === 1 ? () => void differentBot() : undefined}
      backDisabled={busy}
      note={step === 2 ? "Your bot is saved." : undefined}
      actions={step === 0 ? (
        <Button type="button" size="sm" disabled={busy || !token.trim()} onClick={() => void connect()} data-testid="alerts-telegram-continue">
          {busy ? <Delayed><Spinner size={14} /></Delayed> : null}Next
        </Button>
      ) : step === 1 ? <>
        {finishLater}
        <Button ref={openBotButton} type="button" size="sm" disabled={busy} onClick={openStart} data-testid="alerts-telegram-open-bot">
          Open {bot} <ArrowSquareOutIcon size={13} aria-hidden />
        </Button>
      </> : step === 2 ? finishLater : (
        <Button type="button" size="sm" onClick={props.onClose} data-testid="alerts-telegram-done">Done</Button>
      )}
    >
      {step === 0 ? <>
        <p className="alerts-wizard-text">Your own bot sends you each alert with a Got it button. About 3 minutes.</p>
        <div className="alerts-step-actions">
          <Button type="button" variant="outline" size="sm" onClick={() => void window.consensus.openExternal("https://t.me/BotFather")}>
            Open BotFather <ArrowSquareOutIcon size={13} aria-hidden />
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
              data-wizard-autofocus
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
      </> : step === 1 ? <>
        <p className="alerts-wizard-text">Bot <b>{bot}</b></p>
        <p className="alerts-wizard-text">Open it and press <b>Start</b> at the bottom of the chat. The button opens your bot with a one-time code, so only your Start connects it.</p>
        <div className="alerts-waiting" role="status"><Spinner size={13} /> Waiting for Start…</div>
        {startHelp ? <p className="alerts-wizard-text">Nothing yet? <button type="button" className="alerts-text-button" onClick={openStart}>Open it again</button></p> : null}
      </> : step === 2 ? <>
        <p className="alerts-wizard-title">Press Got it in Telegram</p>
        <p className="alerts-wizard-text">A test message with a <b>Got it</b> button is in your chat with {bot}. Press Got it on it.{" "}
          <button type="button" className="alerts-text-button" onClick={openStart}>Open {bot}</button></p>
        <div className="alerts-waiting" role="status"><Spinner size={13} /> Waiting for Got it…</div>
      </> : (
        <div className="alerts-wizard-done" role="status">
          <span className="alerts-wizard-done-mark"><CheckIcon size={20} aria-hidden /></span>
          <p className="alerts-wizard-title">Connected{telegram?.chatName ? ` to ${telegram.chatName}` : ""}</p>
          <p className="alerts-wizard-text">Alerts come to your chat with {bot}.</p>
        </div>
      )}
      {step !== 0 && error ? <div className="gen-row-error" role="alert">{error}</div> : null}
    </AlertsWizard>
  );
}

import { Check, ExternalLink, Info, Loader2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { HubAlertResult, UrgentAlertPhoneCheck, UrgentAlertSettingsView, UrgentAlertUserRequest } from "../../../shared/urgentAlerts";
import { AwsDialog } from "./aws-dialog";

export async function alertRequest<T>(request: UrgentAlertUserRequest): Promise<HubAlertResult<T>> {
  try {
    return await window.consensus.urgentAlertRequest(request) as HubAlertResult<T>;
  } catch (error) {
    return { ok: false, error: { code: "server_unavailable", message: error instanceof Error ? error.message : String(error) } };
  }
}

function Step(props: { n: number; state: "done" | "now" | "later"; title: string; children?: ReactNode }): JSX.Element {
  return (
    <li className={`alerts-step is-${props.state}`}>
      <span className="alerts-step-mark" aria-hidden>{props.state === "done" ? <Check size={13} /> : props.n}</span>
      <div className="alerts-step-text">
        <div className="alerts-step-title">{props.title}</div>
        {props.children}
      </div>
    </li>
  );
}

/** Connect Telegram: the User's own bot (BotFather), Start, then Got it on a
 *  test message. Each step is read back from the server, which does it. */
export function TelegramConnectDialog(props: {
  open: boolean;
  settings?: UrgentAlertSettingsView;
  onSettings: (settings: UrgentAlertSettingsView) => void;
  onClose: () => void;
}): JSX.Element {
  const telegram = props.settings?.telegram;
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const step = !telegram || telegram.error ? 1 : telegram.connected ? 4 : telegram.step === "test" ? 3 : 2;
  const { onSettings } = props;

  // While it waits for Start or Got it, the server is asked what it saw.
  useEffect(() => {
    if (!props.open || (step !== 2 && step !== 3)) return undefined;
    const timer = setInterval(() => {
      void alertRequest<UrgentAlertSettingsView>({ action: "settings" }).then((result) => { if (result.ok) onSettings(result.value); });
    }, 1_500);
    return () => clearInterval(timer);
  }, [props.open, step, onSettings]);

  async function connect(): Promise<void> {
    setBusy(true);
    setError(undefined);
    const result = await alertRequest<UrgentAlertSettingsView>({ action: "telegram.connect", token });
    setBusy(false);
    if (!result.ok) return setError(result.error.message);
    setToken("");
    props.onSettings(result.value);
  }

  const bot = telegram?.botUsername ? `@${telegram.botUsername}` : "your bot";
  return (
    <AwsDialog
      open={props.open}
      title="Connect Telegram"
      description="Your own bot, so messages go only through your server."
      busy={busy}
      testId="alerts-telegram-dialog"
      onClose={props.onClose}
      actions={step === 4
        ? <Button type="button" size="sm" onClick={props.onClose}>Done</Button>
        : <>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={props.onClose}>Cancel</Button>
          {step === 1
            ? <Button type="button" size="sm" disabled={busy || !token.trim()} onClick={() => void connect()} data-testid="alerts-telegram-continue">
              {busy ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null}Continue
            </Button>
            : <Button type="button" size="sm" disabled>Done</Button>}
        </>}
    >
      <ol className="alerts-steps">
        <Step n={1} state={step > 1 ? "done" : "now"} title="Create your bot">
          <div className="alerts-step-detail">
            In Telegram open @BotFather, send <code>/newbot</code>, pick any name, and paste the token it sends back.{" "}
            <button type="button" className="alerts-link" onClick={() => void window.consensus.openExternal("https://t.me/BotFather")}>Open BotFather</button>
          </div>
          {step === 1 ? (
            <input
              className="gen-input alerts-input"
              value={token}
              placeholder="123456789:AAH…"
              autoComplete="off"
              spellCheck={false}
              data-testid="alerts-telegram-token"
              onChange={(event) => setToken(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && token.trim() && !busy) void connect(); }}
            />
          ) : <div className="alerts-done-line"><Check size={13} aria-hidden /> {bot}</div>}
          {telegram?.error ? <div className="gen-row-error" role="alert">{telegram.error}</div> : null}
        </Step>
        <Step n={2} state={step > 2 ? "done" : step === 2 ? "now" : "later"} title="Press Start in your bot">
          <div className="alerts-step-detail">That's how the bot learns where to write to you.</div>
          {step === 2 ? (
            <div className="alerts-step-actions">
              <Button type="button" size="sm" onClick={() => void window.consensus.openExternal(`https://t.me/${telegram?.botUsername ?? ""}?start=connect`)}>
                <ExternalLink size={13} aria-hidden /> Open {bot}
              </Button>
              <span className="alerts-waiting"><Loader2 size={13} className="gen-aws-spinner" aria-hidden /> Waiting for Start…</span>
            </div>
          ) : null}
        </Step>
        <Step n={3} state={step > 3 ? "done" : step === 3 ? "now" : "later"} title="Check it">
          <div className="alerts-step-detail">
            A test message arrives with a Got it button. Press it and this window shows "Connected".
          </div>
          {step === 3 ? <span className="alerts-waiting"><Loader2 size={13} className="gen-aws-spinner" aria-hidden /> Waiting for Got it…</span> : null}
          {step === 4 ? <div className="alerts-done-line"><Check size={13} aria-hidden /> Connected{telegram?.chatName ? ` to ${telegram.chatName}` : ""}</div> : null}
        </Step>
      </ol>
      {error ? <div className="gen-row-error" role="alert">{error}</div> : null}
    </AwsDialog>
  );
}

/** Connect phone call: the User's Twilio account, the number calls come
 *  from (one she has, or buy one), and her phone. */
export function PhoneConnectDialog(props: {
  open: boolean;
  settings?: UrgentAlertSettingsView;
  onSettings: (settings: UrgentAlertSettingsView) => void;
  onClose: () => void;
}): JSX.Element {
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [checked, setChecked] = useState<UrgentAlertPhoneCheck | undefined>();
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState(props.settings?.phone?.to ?? "");
  const [busy, setBusy] = useState<"check" | "save" | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!props.open) return;
    setChecked(undefined);
    setError(undefined);
    setAuthToken("");
    setTo(props.settings?.phone?.to ?? "");
  }, [props.open, props.settings?.phone?.to]);

  async function check(): Promise<void> {
    setBusy("check");
    setError(undefined);
    const result = await alertRequest<UrgentAlertPhoneCheck>({ action: "phone.check", accountSid: accountSid.trim(), authToken: authToken.trim() });
    setBusy(undefined);
    if (!result.ok) return setError(result.error.message);
    setChecked(result.value);
    setFrom(result.value.numbers[0] ?? "buy");
  }

  async function save(): Promise<void> {
    setBusy("save");
    setError(undefined);
    let number = from;
    if (from === "buy") {
      const bought = await alertRequest<{ number: string }>({ action: "phone.buy", accountSid: accountSid.trim(), authToken: authToken.trim() });
      if (!bought.ok) {
        setBusy(undefined);
        return setError(bought.error.message);
      }
      number = bought.value.number;
      setChecked((current) => current ? { ...current, numbers: [...current.numbers, number] } : current);
      setFrom(number);
    }
    const result = await alertRequest<UrgentAlertSettingsView>({ action: "phone.save", accountSid: accountSid.trim(), authToken: authToken.trim(), from: number, to });
    setBusy(undefined);
    if (!result.ok) return setError(result.error.message);
    props.onSettings(result.value);
    props.onClose();
  }

  async function disconnect(): Promise<void> {
    setBusy("save");
    setError(undefined);
    const result = await alertRequest<UrgentAlertSettingsView>({ action: "phone.disconnect" });
    setBusy(undefined);
    if (!result.ok) return setError(result.error.message);
    props.onSettings(result.value);
    props.onClose();
  }

  const step = checked ? 3 : 1;
  return (
    <AwsDialog
      open={props.open}
      title={props.settings?.phone ? "Change phone call" : "Connect phone call"}
      description="Calls go through your Twilio account."
      busy={Boolean(busy)}
      testId="alerts-phone-dialog"
      onClose={props.onClose}
      note={props.settings?.phone
        ? <Button type="button" variant="ghost" size="sm" disabled={Boolean(busy)} data-testid="alerts-phone-disconnect" onClick={() => void disconnect()}>Disconnect phone</Button>
        : undefined}
      actions={<>
        <Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} onClick={props.onClose}>Cancel</Button>
        {checked
          ? <Button type="button" size="sm" disabled={Boolean(busy) || !to.trim() || !from} onClick={() => void save()} data-testid="alerts-phone-save">
            {busy === "save" ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null}{from === "buy" ? "Buy number and save" : "Save"}
          </Button>
          : <Button type="button" size="sm" disabled={Boolean(busy) || !accountSid.trim() || !authToken.trim()} onClick={() => void check()} data-testid="alerts-phone-check">
            {busy === "check" ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null}Continue
          </Button>}
      </>}
    >
      <ol className="alerts-steps">
        <Step n={1} state={step > 1 ? "done" : "now"} title="Twilio account">
          <div className="alerts-step-detail">
            Sign up at twilio.com (free $15 to try, no card), then copy two keys from the Console's first page.{" "}
            <button type="button" className="alerts-link" onClick={() => void window.consensus.openExternal("https://console.twilio.com/")}>Open Twilio Console</button>
          </div>
          <div className="alerts-fields">
            <label className="alerts-field">
              <span>Account SID</span>
              <input className="gen-input alerts-input" value={accountSid} placeholder="AC…" autoComplete="off" spellCheck={false}
                disabled={Boolean(checked)} data-testid="alerts-phone-sid" onChange={(event) => setAccountSid(event.target.value)} />
            </label>
            <label className="alerts-field">
              <span>Auth Token</span>
              <input className="gen-input alerts-input" type="password" value={authToken} autoComplete="off" spellCheck={false}
                disabled={Boolean(checked)} data-testid="alerts-phone-token" onChange={(event) => setAuthToken(event.target.value)} />
            </label>
          </div>
          {checked ? <div className="alerts-done-line"><Check size={13} aria-hidden /> {checked.accountName || "Twilio account"}{checked.trial ? " (trial)" : ""}</div> : null}
        </Step>
        <Step n={2} state={checked ? "now" : "later"} title="Number to call from">
          {checked ? (
            <div className="alerts-choices" role="radiogroup" aria-label="Number to call from">
              {checked.numbers.map((number) => (
                <button key={number} type="button" role="radio" aria-checked={from === number} className={`alerts-choice${from === number ? " is-selected" : ""}`} onClick={() => setFrom(number)}>
                  <span className="alerts-radio" aria-hidden /> <span className="alerts-number">{number}</span><small>already in your account</small>
                </button>
              ))}
              <button type="button" role="radio" aria-checked={from === "buy"} className={`alerts-choice${from === "buy" ? " is-selected" : ""}`} onClick={() => setFrom("buy")}>
                <span className="alerts-radio" aria-hidden /> Buy a new number<small>$1.15 / month</small>
              </button>
            </div>
          ) : <div className="alerts-step-detail">Shown once Twilio accepts the keys.</div>}
        </Step>
        <Step n={3} state={checked ? "now" : "later"} title="Your phone">
          <input className="gen-input alerts-input" value={to} placeholder="+357 99 123456" inputMode="tel" disabled={!checked}
            data-testid="alerts-phone-to" onChange={(event) => setTo(event.target.value)} />
          {checked?.trial ? (
            <div className="alerts-step-detail alerts-note">
              <Info size={13} aria-hidden /> On a free Twilio account calls go only to the number you signed up with, and start with Twilio's short notice asking you to press a key.
            </div>
          ) : null}
        </Step>
      </ol>
      {error ? <div className="gen-row-error" role="alert">{error}</div> : null}
    </AwsDialog>
  );
}

import { AlertTriangle, ArrowRight, Check, CircleCheck, ExternalLink, Loader2, Phone } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { alertsDialogTestLine, alertsTwilioNeedsIdentity } from "../../../shared/urgentAlertSettings";
import {
  URGENT_ALERT_CALL_ATTEMPTS,
  URGENT_ALERT_TEST_STALE_MS,
  normalizePhoneNumber,
  urgentAlertPhoneTestDone,
  urgentAlertPhoneTestPassed,
  type UrgentAlertPhoneCheck,
  type UrgentAlertPhoneTest,
  type UrgentAlertSettingsView
} from "../../../shared/urgentAlerts";
import { AlertsWizard, alertRequest } from "./alerts-shared";

const TWILIO_CONSOLE = "https://console.twilio.com/";
const TWILIO_VERIFIED = "https://console.twilio.com/us1/develop/phone-numbers/manage/verified";
/** Where Twilio asks who owns the account before it sells numbers or calls. */
const TWILIO_TRUST_HUB = "https://console.twilio.com/us1/account/trust-hub/customer-profiles";
/** What a number bought for alerts costs (Twilio's US local number). */
const US_NUMBER_PRICE = "$1.15 / month";
const PHONE_STEPS = ["Twilio account", "Call from", "Your phone", "Test call"] as const;

/**
 * Connect (or change) the phone call one step at a time, as the User approved
 * it on 2026-11-16: her Twilio account (kept: changing the number or the phone
 * needs no keys again), the number calls come from (buying one is the step's
 * own button, with its price), her phone (checked against Twilio's verified
 * numbers on a trial), and a test call before saving.
 */
export function PhoneConnectDialog(props: {
  open: boolean;
  settings?: UrgentAlertSettingsView;
  onSettings: (settings: UrgentAlertSettingsView) => void;
  onClose: () => void;
}): JSX.Element {
  const saved = props.settings?.phone;
  const [step, setStep] = useState(0);
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [checked, setChecked] = useState<UrgentAlertPhoneCheck | undefined>();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState<"check" | "buy" | "try" | "save" | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [boughtNumbers, setBoughtNumbers] = useState<string[]>([]);
  const [test, setTest] = useState<{ id: string; result: UrgentAlertPhoneTest; from: string; to: string } | undefined>();
  const sidField = useRef<HTMLInputElement>(null);
  const phoneField = useRef<HTMLInputElement>(null);
  /** Each opening and closing: an answer that comes back after the dialog
   *  closed (or opened again) belongs to the old one and is dropped. */
  const opening = useRef(0);

  // Opened on a phone that works: the saved account is used at once; on a new
  // one, or one whose keys Twilio refused, the keys are asked for.
  useEffect(() => {
    opening.current += 1;
    setStep(0);
    if (!props.open) {
      setAccountSid("");
      setAuthToken("");
      setShowToken(false);
      setChecked(undefined);
      setTest(undefined);
      setBoughtNumbers([]);
      setError(undefined);
      // Closed while asking: the answer is dropped, so nothing else ends it.
      setBusy(undefined);
      return;
    }
    setTo(saved?.to ?? "");
    setFrom(saved?.from ?? "");
    if (saved && !saved.error) void check(true);
  }, [props.open]);

  // A test call under way is asked about until it is over.
  useEffect(() => {
    if (!test || urgentAlertPhoneTestDone(test.result)) return undefined;
    let stopped = false;
    const timer = setTimeout(() => {
      void alertRequest<{ testId: string; test: UrgentAlertPhoneTest }>({ action: "phone.try-status", testId: test.id }).then((answer) => {
        if (stopped) return;
        if (answer.ok) setTest((current) => current && current.id === answer.value.testId ? { ...current, result: answer.value.test } : current);
        // The server no longer knows it: over. Any other failure (a moment
        // without the server): asked again while the call may still ring.
        else if (answer.error.code === "invalid_request") setTest((current) => current ? { ...current, result: { state: "failed", at: new Date().toISOString(), error: answer.error.message, lost: true } } : current);
        else if (Date.now() - Date.parse(test.result.at) > URGENT_ALERT_TEST_STALE_MS) {
          setTest((current) => current ? { ...current, result: { state: "failed", at: new Date().toISOString(), error: "Your server stopped answering, so how the call went is unknown.", lost: true } } : current);
        } else setTest((current) => current ? { ...current } : current);
      });
    }, 1_500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [test]);

  const keys = checked?.saved ? {} : { accountSid: accountSid.trim(), authToken: authToken.trim() };

  function goTo(next: number): void {
    setError(undefined);
    setStep(next);
  }

  async function check(useSaved = false): Promise<void> {
    const asked = opening.current;
    setBusy("check");
    setError(undefined);
    const result = await alertRequest<UrgentAlertPhoneCheck>(useSaved
      ? { action: "phone.check" }
      : { action: "phone.check", accountSid: accountSid.trim(), authToken: authToken.trim() });
    if (asked !== opening.current) return;
    setBusy(undefined);
    if (!result.ok) return setError(result.error.message);
    setChecked(result.value);
    setFrom((current) => current && result.value.numbers.includes(current) ? current : result.value.numbers.length === 1 ? result.value.numbers[0] : "");
    // Keys she pasted are checked: on to the number. The saved account is
    // shown first, so she sees which one it is.
    if (!useSaved) setStep(1);
  }

  async function buy(): Promise<void> {
    const asked = opening.current;
    const before = checked?.numbers ?? [];
    setBusy("buy");
    setError(undefined);
    const bought = await alertRequest<{ number: string }>({ action: "phone.buy", ...keys });
    if (asked !== opening.current) return;
    if (bought.ok) {
      setBusy(undefined);
      setChecked((current) => current && !current.numbers.includes(bought.value.number) ? { ...current, numbers: [...current.numbers, bought.value.number] } : current);
      return took([bought.value.number]);
    }
    // The answer was lost, but Twilio may have sold the number all the same:
    // the account's list is read again before she could buy a second one.
    const again = await alertRequest<UrgentAlertPhoneCheck>({ action: "phone.check", ...keys });
    if (asked !== opening.current) return;
    setBusy(undefined);
    const appeared = again.ok ? again.value.numbers.filter((number) => !before.includes(number)) : [];
    if (again.ok) setChecked((current) => current ? { ...current, numbers: again.value.numbers } : current);
    if (appeared.length) return took(appeared);
    setError(bought.error.message);
  }

  /** Numbers bought in this dialog: labelled so, and the newest chosen. */
  function took(numbers: string[]): void {
    setBoughtNumbers((current) => [...current, ...numbers]);
    setFrom(numbers[numbers.length - 1]);
  }

  async function callMe(): Promise<void> {
    const asked = opening.current;
    setBusy("try");
    setError(undefined);
    const result = await alertRequest<{ testId: string; test: UrgentAlertPhoneTest }>({ action: "phone.try", ...keys, from, to });
    if (asked !== opening.current) return;
    setBusy(undefined);
    if (!result.ok) return setError(result.error.message);
    setTest({ id: result.value.testId, result: result.value.test, from, to: normalizePhoneNumber(to) ?? to });
  }

  const normalizedTo = normalizePhoneNumber(to);
  /** The test call made of exactly these numbers, if any. */
  const matchingTest = test && test.from === from && test.to === normalizedTo ? test : undefined;

  async function save(): Promise<void> {
    setBusy("save");
    setError(undefined);
    const tested = matchingTest ? { testId: matchingTest.id } : {};
    const result = await alertRequest<UrgentAlertSettingsView>({ action: "phone.save", ...keys, from, to, ...tested });
    setBusy(undefined);
    if (!result.ok) return setError(result.error.message);
    props.onSettings(result.value);
    props.onClose();
  }

  const keypad = props.settings?.callMode !== "answer";
  const verified = checked?.trial && checked.verified && normalizedTo ? checked.verified.includes(normalizedTo) : undefined;
  const currentTest = matchingTest?.result;
  const passed = urgentAlertPhoneTestPassed(currentTest, keypad ? "keypad" : "answer");
  const calling = busy === "try" || currentTest?.state === "calling";
  // Twilio has not confirmed who she is: nothing can be bought or called until
  // it has, whatever she does here.
  // On the number step (buying refused) or the test step (the call refused),
  // only where it happened.
  const identity = (step === 1 && alertsTwilioNeedsIdentity(error)) ||
    (step === 3 && (alertsTwilioNeedsIdentity(error) || (currentTest?.state === "failed" && alertsTwilioNeedsIdentity(currentTest.error))));
  /** Numbers she can still choose from while Twilio will not sell another. */
  const numbersLeft = Boolean(checked?.numbers.length);
  const spinner = (name: typeof busy) => busy === name ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null;

  const trustHub = (
    <Button type="button" size="sm" onClick={() => void window.consensus.openExternal(TWILIO_TRUST_HUB)} data-testid="alerts-phone-trust-hub">
      Open Trust Hub <ExternalLink size={13} aria-hidden />
    </Button>
  );
  const actions = identity && step === 1 && !numbersLeft ? <>
    <Button type="button" variant="outline" size="sm" onClick={props.onClose}>Close</Button>
    {trustHub}
  </> : identity && step === 3 ? <>
    <Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => void save()} data-testid="alerts-phone-save">
      {spinner("save")}Save anyway
    </Button>
    {trustHub}
  </> : step === 0 ? (
    <Button type="button" size="sm" disabled={Boolean(busy) || (!checked && (!accountSid.trim() || !authToken.trim()))}
      onClick={() => (checked ? goTo(1) : void check())} data-testid="alerts-phone-next">
      {spinner("check")}Next
    </Button>
  ) : step === 1 ? (checked?.numbers.length ? <>
    <Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => void buy()} data-testid="alerts-phone-buy" data-wizard-no-autofocus>
      {spinner("buy")}Buy another · {US_NUMBER_PRICE}
    </Button>
    <Button type="button" size="sm" disabled={Boolean(busy) || !from} onClick={() => goTo(2)} data-testid="alerts-phone-next">Next</Button>
  </> : (
    <Button type="button" size="sm" disabled={Boolean(busy)} onClick={() => void buy()} data-testid="alerts-phone-buy" data-wizard-no-autofocus>
      {spinner("buy")}Buy a US number · {US_NUMBER_PRICE}
    </Button>
  )) : step === 2 ? (
    <Button type="button" size="sm" disabled={!normalizedTo} onClick={() => goTo(3)} data-testid="alerts-phone-next">Next</Button>
  ) : passed ? <>
    <Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => void callMe()} data-testid="alerts-phone-try">Call again</Button>
    <Button type="button" size="sm" disabled={Boolean(busy)} onClick={() => void save()} data-testid="alerts-phone-save">{spinner("save")}Save</Button>
  </> : <>
    <Button type="button" variant="outline" size="sm" disabled={Boolean(busy) || calling} onClick={() => void save()} data-testid="alerts-phone-save">
      {spinner("save")}{currentTest && !calling ? "Save anyway" : "Save without a test"}
    </Button>
    <Button type="button" size="sm" disabled={Boolean(busy) || calling} onClick={() => void callMe()} data-testid="alerts-phone-try">
      {calling ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : <Phone size={13} aria-hidden />}{calling ? "Calling…" : currentTest ? "Call again" : "Call me now"}
    </Button>
  </>;

  return (
    <AlertsWizard
      open={props.open}
      title={saved ? "Change phone call" : "Connect phone call"}
      steps={PHONE_STEPS}
      current={step}
      busy={busy === "save" || busy === "buy"}
      testId="alerts-phone-dialog"
      // A working saved account is checked at once: nothing to focus until then.
      initialFocus={() => (saved && !saved.error ? null : sidField.current)}
      onClose={props.onClose}
      focusKey={`${step}:${checked ? `checked:${checked.numbers.length}` : "keys"}:${identity ? "identity" : ""}:${passed ? "passed" : ""}`}
      onBack={step > 0 ? () => goTo(step - 1) : undefined}
      backDisabled={Boolean(busy)}
      actions={actions}
    >
      {identity && !(step === 1 && numbersLeft) ? <IdentityNeeded title={step === 1 ? "The number calls come from" : "Make sure it rings"} telegram={Boolean(props.settings?.telegram?.connected && !props.settings.telegram.error)} /> : step === 0 ? (checked ? <>
        <p className="alerts-wizard-text">Calls come from this Twilio account.</p>
        <div className="alerts-account">
          <span className="alerts-account-name">{checked.accountName || "Your Twilio account"}</span>
          {checked.trial ? <span className="alerts-chip is-warn">Trial</span> : null}
          <button type="button" className="alerts-text-button" disabled={Boolean(busy)} onClick={() => { setChecked(undefined); setTest(undefined); }} data-testid="alerts-phone-other-keys">
            Use other keys
          </button>
        </div>
        <p className="alerts-wizard-text">Balance and charges are in your Twilio Console.</p>
      </> : busy === "check" && saved && !accountSid ? (
        <div className="alerts-waiting" role="status"><Loader2 size={13} className="gen-aws-spinner" aria-hidden /> Checking your Twilio account…</div>
      ) : <>
        <p className="alerts-wizard-text">Calls come from your own Twilio account. You pay Twilio directly.</p>
        <div className="alerts-step-actions">
          <Button type="button" variant="outline" size="sm" onClick={() => void window.consensus.openExternal(TWILIO_CONSOLE)}>
            Open Twilio Console <ExternalLink size={13} aria-hidden />
          </Button>
        </div>
        <div className="alerts-where">In Twilio: <b>Account → API keys &amp; tokens → Live credentials</b></div>
        <label className="alerts-field">
          <span>Account SID</span>
          <input ref={sidField} data-wizard-autofocus className="gen-input alerts-input" value={accountSid} placeholder="AC…" autoComplete="off" spellCheck={false}
            data-testid="alerts-phone-sid" onChange={(event) => setAccountSid(event.target.value)} />
        </label>
        <label className="alerts-field">
          <span>Auth Token</span>
          <span className="alerts-secret">
            <input className="gen-input alerts-input" type={showToken ? "text" : "password"} value={authToken} autoComplete="off" spellCheck={false}
              data-testid="alerts-phone-token" onChange={(event) => setAuthToken(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && accountSid.trim() && authToken.trim() && !busy) void check(); }} />
            <button type="button" className="alerts-show" aria-label="Show token" aria-pressed={showToken} onClick={() => setShowToken((shown) => !shown)}>
              {showToken ? "Hide" : "Show"}
            </button>
          </span>
        </label>
        <div className="alerts-hint">Kept on your server only.</div>
      </>) : step === 1 ? <>
        <p className="alerts-wizard-title">The number calls come from</p>
        {identity ? <div className="alerts-identity" role="alert" data-testid="alerts-phone-identity">
          <b>Twilio won't sell another number yet.</b> It first has to confirm who you are in Trust Hub; you can still use a number you have.
        </div> : null}
        {checked?.numbers.length ? (
          <div className="alerts-choices" role="radiogroup" aria-label="Number to call from">
            {checked.numbers.map((number) => (
              <label key={number} className={`alerts-choice${from === number ? " is-selected" : ""}`}>
                <input type="radio" name="alerts-from" checked={from === number} onChange={() => setFrom(number)}
                  data-wizard-autofocus={from === number || (!from && number === checked.numbers[0]) ? true : undefined} />
                <span className="alerts-number">{number}</span><small>{boughtNumbers.includes(number) ? "bought just now" : "in your account"}</small>
              </label>
            ))}
          </div>
        ) : <>
          <p className="alerts-wizard-text">Your Twilio account has no phone number yet. Buy one for alerts to call you from.</p>
          <div className="alerts-hint">{US_NUMBER_PRICE.replace(" / ", " a ")}, billed by Twilio from your balance.</div>
        </>}
      </> : step === 2 ? <>
        <p className="alerts-wizard-title">The phone that rings</p>
        <label className="alerts-field">
          <span>Your phone</span>
          <input ref={phoneField} data-wizard-autofocus className="gen-input alerts-input" value={to} placeholder="+357 99 123456" inputMode="tel" autoComplete="tel"
            aria-describedby="alerts-phone-to-hint" data-testid="alerts-phone-to" onChange={(event) => setTo(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && normalizedTo) goTo(3); }} />
        </label>
        <div className="alerts-hint" id="alerts-phone-to-hint">
          {verified === true ? <span className="alerts-ok-line"><Check size={13} aria-hidden /> Verified in Twilio</span>
            : verified === false ? <span className="alerts-warn-line">
              <AlertTriangle size={13} aria-hidden /> Not verified in Twilio. A trial account calls only numbers you verify there.{" "}
              <button type="button" className="alerts-text-button" onClick={() => void window.consensus.openExternal(TWILIO_VERIFIED)}>Verify it in Twilio</button>
            </span>
            : "With the country code."}
        </div>
        {checked?.trial ? <div className="alerts-hint">On a trial account a call starts with Twilio's short notice: press any key, then hear the alert.</div> : null}
      </> : <>
        <p className="alerts-wizard-title">Make sure it rings</p>
        <div className="alerts-route">
          <span><small>From</small><b>{from}</b></span>
          <ArrowRight size={15} aria-hidden />
          <span><small>To</small><b>{normalizedTo ?? to}</b></span>
        </div>
        <PhoneTestLine test={currentTest} to={normalizedTo} keypad={keypad} />
        <div className="alerts-hint">Calls are billed by Twilio per minute. One alert rings up to {URGENT_ALERT_CALL_ATTEMPTS} times if you don't press Got it.</div>
      </>}
      {error && !alertsTwilioNeedsIdentity(error) ? <div className="gen-row-error" role="alert">{error}</div> : null}
    </AlertsWizard>
  );
}

/** Twilio's identity check, said in plain words with the way to it. */
function IdentityNeeded(props: { title: string; telegram: boolean }): JSX.Element {
  return <>
    <p className="alerts-wizard-title">{props.title}</p>
    <div className="alerts-identity" role="alert" data-testid="alerts-phone-identity">
      <b>Twilio won't sell a number or place calls yet.</b> It first has to confirm who you are: fill in the primary profile in Trust Hub.
      Twilio reviews it in about 2–8 days; then come back here.
    </div>
    {props.telegram ? <p className="alerts-wizard-text">Alerts still reach you in Telegram.</p> : null}
  </>;
}

function PhoneTestLine(props: { test?: UrgentAlertPhoneTest; to?: string; keypad: boolean }): JSX.Element {
  const words = alertsDialogTestLine(props.test, props.to ?? "your phone", props.keypad);
  const test = props.test;
  if (!test) return <div className="alerts-step-detail">{words}</div>;
  if (test.state === "calling") return <div className="alerts-waiting" role="status"><Loader2 size={13} className="gen-aws-spinner" aria-hidden /> {words}</div>;
  if (urgentAlertPhoneTestPassed(test, props.keypad ? "keypad" : "answer")) return <div className="alerts-ok-line" role="status"><CircleCheck size={14} aria-hidden /> {words}</div>;
  return <div className="alerts-warn-line" role="status"><AlertTriangle size={13} aria-hidden /> {words}</div>;
}

import { AlertTriangle, Check, CircleCheck, ExternalLink, Loader2, Phone } from "lucide-react";
import { alertsDialogTestLine } from "../../../shared/urgentAlertSettings";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { AlertsStep, alertRequest } from "./alerts-shared";
import { AwsDialog } from "./aws-dialog";

const TWILIO_CONSOLE = "https://console.twilio.com/";
const TWILIO_VERIFIED = "https://console.twilio.com/us1/develop/phone-numbers/manage/verified";
/** What a number bought for alerts costs (Twilio's US local number). */
const US_NUMBER_PRICE = "$1.15 / month";

/**
 * Connect (or change) the phone call, as the User approved it on 2026-11-15:
 * her Twilio account (kept: changing the number or the phone needs no keys
 * again), the number calls come from (buying one is never chosen for her and
 * says its price), her phone (checked against Twilio's verified numbers on a
 * trial), and a test call she answers before saving.
 */
export function PhoneConnectDialog(props: {
  open: boolean;
  settings?: UrgentAlertSettingsView;
  onSettings: (settings: UrgentAlertSettingsView) => void;
  onClose: () => void;
}): JSX.Element {
  const saved = props.settings?.phone;
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
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
    if (!props.open) {
      setAccountSid("");
      setAuthToken("");
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
    // The keys are done with: the phone is what she came to change.
    setTimeout(() => phoneField.current?.focus(), 0);
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
  const ready = Boolean(checked && from && from !== "buy" && normalizedTo);
  const verified = checked?.trial && checked.verified && normalizedTo ? checked.verified.includes(normalizedTo) : undefined;
  const currentTest = matchingTest?.result;
  return (
    <AwsDialog
      open={props.open}
      title={saved ? "Change phone call" : "Connect phone call"}
      description="Twilio calls you if you don't press Got it. You pay Twilio directly."
      busy={busy === "save" || busy === "buy"}
      testId="alerts-phone-dialog"
      className="alerts-dialog"
      // A working saved account is checked at once: nothing to focus until then.
      initialFocus={() => (saved && !saved.error ? null : sidField.current)}
      onClose={props.onClose}
      actions={<>
        <Button type="button" variant="outline" size="sm" disabled={busy === "save" || busy === "buy"} onClick={props.onClose}>Cancel</Button>
        {checked
          ? <Button type="button" size="sm" disabled={Boolean(busy) || !ready} onClick={() => void save()} data-testid="alerts-phone-save">
            {busy === "save" ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null}Save
          </Button>
          : <Button type="button" size="sm" disabled={Boolean(busy) || !accountSid.trim() || !authToken.trim()} onClick={() => void check()} data-testid="alerts-phone-check">
            {busy === "check" ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null}Continue
          </Button>}
      </>}
    >
      <div className="alerts-dialog-body">
      <ol className="alerts-steps">
        <AlertsStep n={1} state={checked ? "done" : "now"} title={checked
          ? <>Twilio account: {checked.accountName || "your account"}{checked.trial ? <span className="alerts-chip is-warn">Trial</span> : null}
            <button type="button" className="alerts-text-button" disabled={Boolean(busy)} aria-label="Edit Twilio keys" onClick={() => { setChecked(undefined); setTest(undefined); setTimeout(() => sidField.current?.focus(), 0); }}>
              Edit
            </button></>
          : "Connect your Twilio account"}>
          {checked ? null : busy === "check" && saved && !accountSid ? (
            <div className="alerts-waiting" role="status"><Loader2 size={13} className="gen-aws-spinner" aria-hidden /> Checking your Twilio account…</div>
          ) : <>
            <div className="alerts-step-actions">
              <Button type="button" variant="outline" size="sm" onClick={() => void window.consensus.openExternal(TWILIO_CONSOLE)}>
                <ExternalLink size={13} aria-hidden /> Open Twilio Console
              </Button>
            </div>
            <div className="alerts-step-detail">Sign up at twilio.com, then copy the Account SID and the Auth Token from the Console's first page (Account Info).</div>
            <label className="alerts-field">
              <span>Account SID</span>
              <input ref={sidField} className="gen-input alerts-input" value={accountSid} placeholder="AC…" autoComplete="off" spellCheck={false}
                data-testid="alerts-phone-sid" onChange={(event) => setAccountSid(event.target.value)} />
            </label>
            <label className="alerts-field">
              <span>Auth Token</span>
              <input className="gen-input alerts-input" type="password" value={authToken} autoComplete="off" spellCheck={false}
                data-testid="alerts-phone-token" onChange={(event) => setAuthToken(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && accountSid.trim() && authToken.trim() && !busy) void check(); }} />
            </label>
            <div className="alerts-hint">Kept on your server only.</div>
          </>}
        </AlertsStep>
        <AlertsStep n={2} state={checked ? "now" : "later"} title="Numbers">
          {checked ? <>
            <div className="alerts-label">Call from</div>
            <div className="alerts-choices" role="radiogroup" aria-label="Number to call from">
              {checked.numbers.map((number) => (
                <label key={number} className={`alerts-choice${from === number ? " is-selected" : ""}`}>
                  <input type="radio" name="alerts-from" checked={from === number} onChange={() => setFrom(number)} />
                  <span className="alerts-number">{number}</span><small>{boughtNumbers.includes(number) ? "bought just now" : "already in your account"}</small>
                </label>
              ))}
              <label className={`alerts-choice${from === "buy" ? " is-selected" : ""}`}>
                <input type="radio" name="alerts-from" checked={from === "buy"} onChange={() => setFrom("buy")} />
                <span>Buy a US number</span><small>{US_NUMBER_PRICE}, billed by Twilio</small>
              </label>
            </div>
            {from === "buy" ? (
              <div className="alerts-step-actions">
                <Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => void buy()} data-testid="alerts-phone-buy">
                  {busy === "buy" ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null}Buy a US number for {US_NUMBER_PRICE}
                </Button>
              </div>
            ) : null}
            <label className="alerts-field">
              <span>Your phone</span>
              <input ref={phoneField} className="gen-input alerts-input" value={to} placeholder="+1 415 555 0134" inputMode="tel" autoComplete="tel"
                aria-describedby="alerts-phone-to-hint" data-testid="alerts-phone-to" onChange={(event) => setTo(event.target.value)} />
            </label>
            <div className="alerts-hint" id="alerts-phone-to-hint">
              {verified === true ? <span className="alerts-ok-line"><Check size={13} aria-hidden /> Verified in Twilio</span>
                : verified === false ? <span className="alerts-warn-line">
                  <AlertTriangle size={13} aria-hidden /> Not verified in Twilio: a trial account can't call it.{" "}
                  <button type="button" className="alerts-text-button" onClick={() => void window.consensus.openExternal(TWILIO_VERIFIED)}>Verify it in Twilio</button>
                </span>
                : "With the country code."}
            </div>
            {checked.trial ? <div className="alerts-hint">On a trial account a call starts with Twilio's short notice: press any key, then hear the alert.</div> : null}
          </> : null}
        </AlertsStep>
        <AlertsStep n={3} state={checked ? "now" : "later"} title="Test call">
          {checked ? <>
            <div className="alerts-step-actions">
              <Button type="button" variant="outline" size="sm" disabled={Boolean(busy) || !ready || currentTest?.state === "calling"} onClick={() => void callMe()} data-testid="alerts-phone-try">
                {busy === "try" ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : <Phone size={13} aria-hidden />} Call me now
              </Button>
            </div>
            <PhoneTestLine test={currentTest} to={normalizedTo} keypad={keypad} />
          </> : null}
        </AlertsStep>
      </ol>
      {checked ? <div className="alerts-cost">Calls are billed by Twilio per minute. One alert rings <b>up to {URGENT_ALERT_CALL_ATTEMPTS} times</b> if you don't press Got it.</div> : null}
      {error ? <div className="gen-row-error" role="alert">{error}</div> : null}
      </div>
    </AwsDialog>
  );
}

function PhoneTestLine(props: { test?: UrgentAlertPhoneTest; to?: string; keypad: boolean }): JSX.Element {
  const words = alertsDialogTestLine(props.test, props.to ?? "your phone", props.keypad);
  const test = props.test;
  if (!test) return <div className="alerts-step-detail">{words}</div>;
  if (test.state === "calling") return <div className="alerts-waiting" role="status"><Loader2 size={13} className="gen-aws-spinner" aria-hidden /> {words}</div>;
  if (urgentAlertPhoneTestPassed(test, props.keypad ? "keypad" : "answer")) return <div className="alerts-ok-line" role="status"><CircleCheck size={14} aria-hidden /> {words}</div>;
  return <div className="alerts-warn-line" role="status"><AlertTriangle size={13} aria-hidden /> {words}</div>;
}

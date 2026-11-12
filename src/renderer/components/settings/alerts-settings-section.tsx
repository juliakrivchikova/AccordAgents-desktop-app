import { Lock, Minus, Phone, Plus, Send } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  URGENT_ALERT_WAIT_MINUTES_MAX,
  URGENT_ALERT_WAIT_MINUTES_MIN,
  maskedPhoneNumber,
  type UrgentAlertSettingsView
} from "../../../shared/urgentAlerts";
import { PhoneConnectDialog, TelegramConnectDialog, alertRequest } from "./alerts-connect-dialogs";

/**
 * Settings → Alerts (the User's design of 2026-11-12): Telegram, where
 * members message her first, and a phone call when she does not press Got
 * it in time. Everything is kept and done on her server; this page only
 * asks it.
 */
export function AlertsSettingsSection(): JSX.Element {
  const [settings, setSettings] = useState<UrgentAlertSettingsView | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [dialog, setDialog] = useState<"telegram" | "phone" | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | undefined>();

  const load = useCallback(async () => {
    const result = await alertRequest<UrgentAlertSettingsView>({ action: "settings" });
    if (result.ok) {
      setSettings(result.value);
      setLoadError(undefined);
    } else {
      setLoadError(result.error.message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function act(name: string, run: () => Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>, done?: string): Promise<void> {
    setBusy(name);
    setNotice(undefined);
    const result = await run();
    setBusy(undefined);
    if (!result.ok) return setNotice({ text: result.error?.message ?? "Your server did not answer.", error: true });
    if (result.value && typeof result.value === "object" && "waitMinutes" in (result.value as object)) setSettings(result.value as UrgentAlertSettingsView);
    if (done) setNotice({ text: done });
  }

  const telegram = settings?.telegram;
  const phone = settings?.phone;
  const wait = settings?.waitMinutes ?? 5;
  const changeWait = (minutes: number) => void act("wait", () => alertRequest({ action: "wait", minutes }));
  return (
    <div className="alerts-settings" data-testid="alerts-settings">
      <p className="alerts-intro">
        When something urgent happens while you're away, a member messages you in Telegram. If you don't press <b>Got it</b> in time, it calls you and reads the same message.
      </p>
      {loadError ? <div className="gen-row-error" role="alert">{loadError}</div> : null}

      <section className="gen-section">
        <div className="gen-section-head">
          <h2 className="gen-section-title">Telegram</h2>
          <span className={`gen-section-meta${telegram?.connected ? " alerts-ok" : ""}`}>
            {telegram?.connected ? <><span className="alerts-dot" />Connected</> : telegram && !telegram.error ? "Not finished" : "Not connected"}
          </span>
        </div>
        <div className="gen-card">
          <div className="gen-row">
            <span className="alerts-tile is-telegram" aria-hidden><Send size={18} /></span>
            <div className="gen-row-text">
              <div className="gen-row-title">{telegram?.connected ? `@${telegram.botUsername}${telegram.chatName ? ` → ${telegram.chatName}` : ""}` : "Telegram"}</div>
              <div className="gen-row-desc">{telegram?.connected ? "Alerts arrive in your chat with this bot." : "Members message you here first."}</div>
              {telegram?.error ? <div className="gen-row-error" role="alert">{telegram.error}</div> : null}
            </div>
            <div className="alerts-actions">
              {telegram?.connected ? <>
                <Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => void act("telegram.test", () => alertRequest({ action: "telegram.test" }), "A test message is on its way to Telegram.")}>Send test</Button>
                <Button type="button" variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => void act("telegram.disconnect", () => alertRequest({ action: "telegram.disconnect" }))}>Disconnect</Button>
              </> : (
                <Button type="button" size="sm" data-testid="alerts-connect-telegram" onClick={() => setDialog("telegram")}>
                  {telegram && !telegram.error ? "Finish connecting" : "Connect Telegram"}
                </Button>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="gen-section">
        <div className="gen-section-head">
          <h2 className="gen-section-title">Phone call</h2>
          <span className={`gen-section-meta${phone ? " alerts-ok" : ""}`}>{phone ? <><span className="alerts-dot" />Connected</> : "Not connected"}</span>
        </div>
        <div className="gen-card">
          <div className="gen-row">
            <span className="alerts-tile is-phone" aria-hidden><Phone size={18} /></span>
            <div className="gen-row-text">
              <div className="gen-row-title">{phone ? `Calls you at ${maskedPhoneNumber(phone.to)}` : "Phone call"}</div>
              <div className="gen-row-desc">
                {phone
                  ? `From ${phone.from} through your Twilio account${phone.trial ? " (trial)" : ""} · number $1.15/month; calls are billed by Twilio per minute`
                  : "If you don't press Got it, they call you. Needs a Twilio account."}
              </div>
              {phone?.error ? <div className="gen-row-error" role="alert">{phone.error}</div> : null}
            </div>
            <div className="alerts-actions">
              {phone ? <>
                <Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => void act("phone.test", () => alertRequest({ action: "phone.test" }), "Calling you now.")}>Test call</Button>
                <Button type="button" variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => setDialog("phone")}>Change</Button>
              </> : (
                <Button type="button" variant="outline" size="sm" data-testid="alerts-connect-phone" onClick={() => setDialog("phone")}>Connect phone</Button>
              )}
            </div>
          </div>
          {phone ? <>
            <div className="gen-card-divider" />
            <div className="gen-row">
              <div className="gen-row-text">
                <div className="gen-row-title">Call if you don't press Got it within</div>
                <div className="gen-row-desc">Counted from the moment the alert comes in. Without an answer it calls twice more, 3 minutes apart.</div>
              </div>
              <div className="alerts-stepper" role="group" aria-label="Minutes before the call">
                <button type="button" aria-label="Fewer minutes" disabled={Boolean(busy) || wait <= URGENT_ALERT_WAIT_MINUTES_MIN} onClick={() => changeWait(wait - 1)}><Minus size={14} /></button>
                <span data-testid="alerts-wait">{wait} min</span>
                <button type="button" aria-label="More minutes" disabled={Boolean(busy) || wait >= URGENT_ALERT_WAIT_MINUTES_MAX} onClick={() => changeWait(wait + 1)}><Plus size={14} /></button>
              </div>
            </div>
          </> : null}
        </div>
        {!phone ? <p className="alerts-hint">Phone call can be added later; Telegram alone works.</p> : null}
      </section>

      {notice ? <div className={notice.error ? "gen-row-error" : "alerts-notice"} role={notice.error ? "alert" : "status"}>{notice.text}</div> : null}
      <p className="alerts-footnote">
        <Lock size={13} aria-hidden />
        {settings?.callMode === "answer"
          ? "Without your own server, alerts work only while this Mac is awake, and answering the call counts as Got it."
          : "Keys are kept on your server, so alerts and calls work while this Mac is closed. They work the same for members on this Mac and on your cloud machines."}
      </p>

      <TelegramConnectDialog open={dialog === "telegram"} settings={settings} onSettings={setSettings} onClose={() => { setDialog(undefined); void load(); }} />
      <PhoneConnectDialog open={dialog === "phone"} settings={settings} onSettings={setSettings} onClose={() => { setDialog(undefined); void load(); }} />
    </div>
  );
}

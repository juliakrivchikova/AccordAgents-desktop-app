import { Info, Loader2, Phone, Send, Server } from "lucide-react";
import { useCallback, useContext, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  alertsBand,
  alertsPhoneStatus,
  alertsPhoneTestLine,
  alertsTelegramStatus,
  alertsTelegramTestLine
} from "../../../shared/urgentAlertSettings";
import type { UrgentAlertSettingsView } from "../../../shared/urgentAlerts";
import { UrgentAlertActionsContext } from "../chat/urgent-alert-context";
import { TelegramConnectDialog, alertRequest, useSettingsWatch } from "./alerts-connect-dialogs";
import { PhoneConnectDialog } from "./alerts-phone-dialog";
import { AlertsBandPlaceholder, AlertsChannelRow, AlertsFlow, AlertsStatusBand } from "./alerts-settings-parts";
import { AwsConfirmDialog } from "./aws-dialog";

type Confirm = "remove-telegram" | "different-bot" | "remove-phone";

/** How long after Send test message the page keeps looking for its Got it. */
const TELEGRAM_TEST_WATCH_MS = 2 * 60_000;

/**
 * Settings → Alerts, as the User approved it on 2026-11-15 (five reviews,
 * mockup "Settings → Alerts · new page"): one line on top that says whether
 * an alert reaches her now, what happens when one comes in (with the wait),
 * and one card for where alerts go, each channel's status beside its name.
 * Everything is kept and done on her server; this page only asks it.
 */
export function AlertsSettingsSection(): JSX.Element {
  const actions = useContext(UrgentAlertActionsContext);
  const [settings, setSettings] = useState<UrgentAlertSettingsView | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<"telegram" | "phone" | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [rowError, setRowError] = useState<{ row: "telegram" | "phone" | "wait"; text: string } | undefined>();
  const [confirm, setConfirm] = useState<Confirm | undefined>();
  const [confirmError, setConfirmError] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    const result = await alertRequest<UrgentAlertSettingsView>({ action: "settings" });
    setLoading(false);
    if (result.ok) {
      setSettings(result.value);
      setLoadError(undefined);
    } else {
      setLoadError(result.error.message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const telegram = settings?.telegram;
  const phone = settings?.phone;
  // The page keeps asking while something is under way elsewhere: a test call
  // ringing, a bot waiting for Start or Got it, a test message's Got it.
  const testSentAt = telegram?.lastTest && !telegram.lastTest.gotIt ? Date.parse(telegram.lastTest.at) : Number.NaN;
  const watching = Boolean(settings) && !dialog && (
    phone?.lastTest?.state === "calling" ||
    Boolean(telegram && !telegram.connected && !telegram.error) ||
    (Number.isFinite(testSentAt) && Date.now() - testSentAt < TELEGRAM_TEST_WATCH_MS));
  useSettingsWatch(watching, setSettings);

  async function act(name: string, row: "telegram" | "phone" | "wait", run: () => ReturnType<typeof alertRequest<UrgentAlertSettingsView>>): Promise<boolean> {
    setBusy(name);
    setRowError(undefined);
    const result = await run();
    setBusy(undefined);
    if (!result.ok) {
      setRowError({ row, text: result.error.message });
      return false;
    }
    setSettings(result.value);
    return true;
  }

  async function confirmed(): Promise<void> {
    const which = confirm;
    if (!which) return;
    setBusy("confirm");
    setConfirmError(undefined);
    const result = await alertRequest<UrgentAlertSettingsView>({ action: which === "remove-phone" ? "phone.disconnect" : "telegram.disconnect" });
    setBusy(undefined);
    if (!result.ok) return setConfirmError(result.error.message);
    setSettings(result.value);
    setConfirm(undefined);
    if (which === "different-bot") setDialog("telegram");
  }

  const errorFor = (row: "telegram" | "phone" | "wait") => rowError?.row === row ? { text: rowError.text, tone: "error" as const } : undefined;
  const band = settings ? alertsBand(settings) : undefined;
  const bandAction = band?.action === "reconnect-telegram" ? <Button type="button" size="sm" onClick={() => setDialog("telegram")}>Reconnect Telegram</Button>
    : band?.action === "reconnect-phone" ? <Button type="button" size="sm" onClick={() => setDialog("phone")}>Reconnect phone call</Button>
    : band?.action === "set-up-server" && actions ? <Button type="button" variant="outline" size="sm" onClick={() => actions.openServerSettings()}><Server size={13} aria-hidden /> Set up your server</Button>
    : undefined;

  const telegramStatus = settings ? alertsTelegramStatus(settings) : "not-set-up";
  const phoneStatus = settings ? alertsPhoneStatus(settings) : "not-set-up";
  const bot = telegram?.botUsername ? `@${telegram.botUsername}` : "your bot";
  const keypad = settings?.callMode !== "answer";
  const testing = phone?.lastTest?.state === "calling";
  return (
    <div className="alerts-settings" data-testid="alerts-settings">
      <p className="alerts-intro">
        When a member raises an urgent alert, it comes to your Telegram with a <b>Got it</b> button. If you don't press Got it in time, you get a call that reads it out; press <b>1</b> on the call for Got it.
      </p>
      {band ? <AlertsStatusBand band={band} action={bandAction} /> : <AlertsBandPlaceholder loading={loading} error={loadError} onRetry={() => void load()} />}

      {settings ? <>
        <AlertsFlow
          waitMinutes={settings.waitMinutes}
          telegram={telegramStatus === "ready"}
          phone={Boolean(phone && !phone.error)}
          answerMode={!keypad}
          busy={Boolean(busy)}
          onWait={(minutes) => void act("wait", "wait", () => alertRequest({ action: "wait", minutes }))}
        />
        {rowError?.row === "wait" ? <div className="gen-row-error" role="alert">{rowError.text}</div> : null}

        <section className="gen-section">
          <div className="gen-section-head"><h2 className="gen-section-title">Where alerts go</h2></div>
          <div className="gen-card">
            <AlertsChannelRow
              testId="alerts-telegram"
              icon={<Send size={17} />}
              name="Telegram"
              status={telegramStatus}
              lines={telegramStatus === "not-set-up" ? [{ text: "Your own bot sends you each alert with a Got it button." }, errorFor("telegram")]
                : telegramStatus === "not-finished" ? [{ text: telegram?.step === "test" ? `Waiting for you to press Got it on the test message from ${bot}` : `Waiting for you to press Start in ${bot}` }, errorFor("telegram")]
                : [
                  { text: `${bot}${telegram?.chatName ? ` → ${telegram.chatName}` : ""}` },
                  telegram?.error ? { text: telegram.error, tone: "error" } : { text: alertsTelegramTestLine(settings) ?? "" },
                  errorFor("telegram")
                ]}
              action={telegramStatus === "ready"
                ? <Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} data-testid="alerts-telegram-test"
                  onClick={() => void act("telegram.test", "telegram", () => alertRequest({ action: "telegram.test" }))}>
                  {busy === "telegram.test" ? <Loader2 size={13} className="gen-aws-spinner" aria-hidden /> : null}Send test message
                </Button>
                : <Button type="button" size="sm" data-testid="alerts-connect-telegram" onClick={() => setDialog("telegram")}>
                  {telegramStatus === "attention" ? "Reconnect" : telegramStatus === "not-finished" ? "Continue" : "Connect Telegram"}
                </Button>}
              menu={telegram ? [
                ...(telegramStatus === "ready" || telegramStatus === "not-finished" ? [{ label: "Use a different bot", onSelect: () => { setConfirmError(undefined); setConfirm("different-bot"); } }] : []),
                { label: "Remove", danger: true, onSelect: () => { setConfirmError(undefined); setConfirm("remove-telegram"); } }
              ] : undefined}
            />
            <div className="gen-card-divider" />
            <AlertsChannelRow
              testId="alerts-phone"
              icon={<Phone size={17} />}
              name="Phone call"
              status={phoneStatus}
              lines={!phone ? [{ text: "Calls you if you don't press Got it in Telegram." }, { text: "Needs a Twilio account · optional" }]
                : [
                  { text: `Calls ${phone.to} from ${phone.from}` },
                  phone.error ? { text: phone.error, tone: "error" }
                    : { text: [keypad ? "On the call, press 1 for Got it" : "Answering the call counts as Got it", alertsPhoneTestLine(settings)].filter(Boolean).join(" · ") },
                  phone.trial ? { text: "Twilio trial: calls reach only numbers verified in Twilio and start with Twilio's notice.", tone: "warn" } : undefined,
                  errorFor("phone")
                ]}
              action={!phone
                ? <Button type="button" variant="outline" size="sm" data-testid="alerts-connect-phone" onClick={() => setDialog("phone")}>Connect phone call</Button>
                : phone.error
                  ? <Button type="button" size="sm" data-testid="alerts-connect-phone" onClick={() => setDialog("phone")}>Reconnect</Button>
                  : <Button type="button" variant={phoneStatus === "ready" ? "outline" : "default"} size="sm" disabled={Boolean(busy) || testing} data-testid="alerts-phone-test"
                    onClick={() => void act("phone.test", "phone", () => alertRequest({ action: "phone.test" }))}>
                    {busy === "phone.test" || testing ? <Loader2 size={13} className="gen-aws-spinner" aria-hidden /> : null}Test call
                  </Button>}
              menu={phone ? [
                ...(phone.error ? [] : [{ label: "Change", onSelect: () => setDialog("phone") }]),
                { label: "Remove", danger: true, onSelect: () => { setConfirmError(undefined); setConfirm("remove-phone"); } }
              ] : undefined}
            />
          </div>
        </section>

        <p className="alerts-footnote">
          <Info size={13} aria-hidden />
          Your bot token and Twilio keys are kept on your server and used only to message and call you. Telegram and Twilio see an alert's text.
        </p>
      </> : null}

      <TelegramConnectDialog open={dialog === "telegram"} settings={settings} onSettings={setSettings} onClose={() => { setDialog(undefined); void load(); }} />
      <PhoneConnectDialog open={dialog === "phone"} settings={settings} onSettings={setSettings} onClose={() => { setDialog(undefined); void load(); }} />
      <AwsConfirmDialog
        open={Boolean(confirm)}
        title={confirm === "remove-phone" ? "Remove phone call?" : confirm === "different-bot" ? "Use a different bot?" : "Remove Telegram?"}
        description={confirm === "remove-phone"
          ? "Alerts won't call you. Your Twilio account and its numbers stay as they are; a number bought for alerts keeps costing until you release it in Twilio."
          : confirm === "different-bot"
            ? `Alerts stop coming from ${bot} until you connect the new bot.`
            : `Alerts won't reach you in Telegram. ${bot} stays in Telegram; delete it in @BotFather if you no longer need it.`}
        confirmLabel={confirm === "different-bot" ? "Continue" : "Remove"}
        pending={busy === "confirm"}
        error={confirmError}
        testId="alerts-confirm"
        onConfirm={() => void confirmed()}
        onClose={() => setConfirm(undefined)}
      />
    </div>
  );
}

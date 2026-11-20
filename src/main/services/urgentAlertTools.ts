import { createHash } from "node:crypto";
import type { HubAlertRequest, HubAlertResult, UrgentAlertRaised } from "../../shared/urgentAlerts";

/** The one way to urgent alerts: the User's server (ServerChatLink.alerts). */
export interface UrgentAlertServerAccess {
  alerts<T>(request: HubAlertRequest, cancel?: AbortSignal): Promise<HubAlertResult<T>>;
}

export interface UrgentAlertToolActor {
  conversationId: string;
  participantId: string;
}

/** A member's app_urgent_alert call, as one request to the server. */
export async function callUrgentAlertTool(access: UrgentAlertServerAccess | undefined, actor: UrgentAlertToolActor, raw: unknown): Promise<unknown> {
  if (!access) {
    return { ok: false, error: { code: "server_unavailable", message: "This device is not linked to your server yet, so the alert was not sent. Tell User in the chat instead." } };
  }
  const args = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const text = typeof args.message === "string" ? args.message : "";
  const result = await access.alerts<UrgentAlertRaised>({
    action: "raise",
    conversationId: actor.conversationId,
    participantId: actor.participantId,
    text,
    // Without one: the same message within a minute (a retry after a lost
    // answer) is the same alert; a later one is a new alert.
    requestId: typeof args.requestId === "string" && args.requestId
      ? args.requestId
      : createHash("sha256").update(`${actor.conversationId}\n${actor.participantId}\n${text}\n${Math.floor(Date.now() / 60_000)}`).digest("hex").slice(0, 32)
  });
  if (!result.ok) {
    return result.error.code === "server_unavailable"
      ? { ok: false, error: { ...result.error, message: `${result.error.message} The alert may not have been sent; call the tool again with the same message (it is not sent twice), or tell User in the chat.` } }
      : result;
  }
  const raised = result.value;
  const note = raised.state === "not_set_up"
    ? "User has not connected Telegram or a phone (Settings → Alerts), so the alert reached her only as a red card in this chat. Say so in your reply."
    : `Sent${raised.telegram ? " to User's Telegram with a Got it button" : ""}${raised.phone ? `${raised.telegram ? ";" : ""} her phone rings and the message is read out if she does not react in time` : ""}. It goes on by itself on the server; do not send the same alert again unless something new happens.`;
  return { ok: true, value: raised, note };
}

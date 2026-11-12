import { randomUUID } from "node:crypto";
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
  const result = await access.alerts<UrgentAlertRaised>({
    action: "raise",
    conversationId: actor.conversationId,
    participantId: actor.participantId,
    text: typeof args.message === "string" ? args.message : "",
    requestId: typeof args.requestId === "string" && args.requestId ? args.requestId : randomUUID()
  });
  if (!result.ok) {
    return result.error.code === "server_unavailable"
      ? { ok: false, error: { ...result.error, message: `${result.error.message} The alert was not sent; tell User in the chat instead.` } }
      : result;
  }
  const raised = result.value;
  const note = raised.state === "not_set_up"
    ? "User has not connected Telegram or a phone (Settings → Alerts), so the alert reached her only as a red card in this chat. Say so in your reply."
    : `Sent${raised.telegram ? " to User's Telegram with a Got it button" : ""}${raised.phone ? `${raised.telegram ? ";" : ""} her phone rings and the message is read out if she does not react in time` : ""}. It goes on by itself on the server; do not send the same alert again unless something new happens.`;
  return { ok: true, value: raised, note };
}

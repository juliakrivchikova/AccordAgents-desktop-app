export interface MobileMailboxExecutionClaimRequest {
  conversationId: string;
  eventId: string;
  ownerId: string;
  ownerRole: "desktop" | "cloud-runner";
  runId: string;
  ttlMs?: number;
}

export interface MobileMailboxExecutionClaim {
  conversationId: string;
  eventId: string;
  ownerId: string;
  ownerRole: string;
  runId: string;
  claimedAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface MobileMailboxExecutionClaimResult {
  acquired: boolean;
  claim?: MobileMailboxExecutionClaim;
}

export function mobileMailboxClaimUrlFromEventsUrl(eventsUrl: string): string {
  const url = new URL(eventsUrl);
  url.pathname = "/v1/mailbox/claims";
  return url.toString();
}

export async function acquireMobileMailboxExecutionClaim(
  eventsUrl: string,
  request: MobileMailboxExecutionClaimRequest,
  signal?: AbortSignal,
  headers?: Record<string, string>
): Promise<MobileMailboxExecutionClaimResult> {
  const response = await fetch(mobileMailboxClaimUrlFromEventsUrl(eventsUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify(request),
    signal
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Mailbox claim failed with HTTP ${response.status}: ${text}`);
  }
  const body = text.trim() ? JSON.parse(text) as Partial<MobileMailboxExecutionClaimResult> : {};
  return {
    acquired: body.acquired === true,
    ...(body.claim ? { claim: body.claim } : {})
  };
}

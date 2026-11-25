import { timingSafeEqual } from "node:crypto";
import type { PhoneTestRun } from "./types";

/** The same Twilio keys (a pasted pair is the saved one only if both match). */
export function sameKeys(left: { accountSid: string; authToken: string }, right: { accountSid: string; authToken: string }): boolean {
  return left.accountSid === right.accountSid && sameSecret(left.authToken, right.authToken);
}

/** Which phone a test call is a test of: its account, number and phone. */
export function testKeyOf(run: PhoneTestRun): string {
  return `${run.credentials.accountSid}|${run.from}|${run.to}`;
}

export function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function twilioCredentials(accountSid: unknown, authToken: unknown): { accountSid: string; authToken: string } | undefined {
  const sid = typeof accountSid === "string" ? accountSid.trim() : "";
  const token = typeof authToken === "string" ? authToken.trim() : "";
  return /^AC[0-9a-fA-F]{32}$/.test(sid) && /^[0-9a-zA-Z]{32}$/.test(token) ? { accountSid: sid, authToken: token } : undefined;
}

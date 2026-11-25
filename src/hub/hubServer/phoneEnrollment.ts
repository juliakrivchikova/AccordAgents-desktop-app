import {
  HUB_AUTH_MAX_SKEW_MS, HUB_PROTOCOL_VERSION, hubPhoneEnrollmentSigningText, HUB_PHONE_INVITE_MAX_LIFETIME_MS, isHubPhoneInviteId,
  isHubPhoneScope, type HubDevice, type HubPhoneCertificate, type HubPhoneEnrollRequest, type HubPhoneEnrollResponse,
  type HubPhoneEnrollment, type HubPhoneInvite
} from "../../shared/hubProtocol";
import { deviceIdForPublicKey, sha256Hex, verifyHubText } from "../../main/services/hubAuth";
import { CONTROL_CHARACTER, ENROLL_ATTEMPTS_ALL, ENROLL_ATTEMPTS_PER_ADDRESS } from "./constants";
import { HubRequestError } from "./httpAnswers";
import type { HubServerModules } from "./modules";
import type { HubServerDependencies } from "./dependencies";

/** Phones that join by an invite. */
export class PhoneEnrollment {
  /** Enrollment attempts per address in the last minute, and all together:
   *  nobody can make the hub check tokens without end. */
  private readonly enrollAttempts = new Map<string, number[]>();
  private enrollQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly server: Pick<HubServerModules, "deviceAuth">,
    private readonly deps: Pick<HubServerDependencies, "now" | "options">
  ) {}

  limitEnrollments(address: string): void {
    const now = this.deps.now();
    const recent = (this.enrollAttempts.get(address) ?? []).filter((at) => now - at < 60_000);
    const all = [...this.enrollAttempts.values()].reduce((count, list) => count + list.filter((at) => now - at < 60_000).length, 0);
    // Per address against guessing (a code is 256 bits: nobody guesses it);
    // all together only against load, high enough that strangers cannot
    // keep the User's own phone from pairing.
    if (recent.length >= ENROLL_ATTEMPTS_PER_ADDRESS || all >= ENROLL_ATTEMPTS_ALL) throw new HubRequestError(429, "Too many pairing attempts; try again in a minute.");
    recent.push(now);
    this.enrollAttempts.set(address, recent);
    if (this.enrollAttempts.size > 1_000) {
      for (const [key, list] of this.enrollAttempts) if (!list.some((at) => now - at < 60_000)) this.enrollAttempts.delete(key);
    }
  }

  validInvite(value: unknown, owner: HubDevice): HubPhoneInvite {
    const invite = value as Partial<HubPhoneInvite> | undefined;
    const now = this.deps.now();
    const expiresAt = Date.parse(invite?.expiresAt ?? "");
    const issuedAt = Date.parse(invite?.issuedAt ?? "");
    if (!invite || invite.version !== 1 || !isHubPhoneInviteId(invite.inviteId) ||
        invite.hubId !== this.deps.options.hubId || invite.issuerDeviceId !== owner.deviceId ||
        typeof invite.tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(invite.tokenHash) ||
        // Every chat: the order has no per-chat fences for a phone's writes.
        !isHubPhoneScope(invite.scope) || invite.scope.scope !== "device" ||
        typeof invite.name !== "string" || invite.name.length > 200 || CONTROL_CHARACTER.test(invite.name) ||
        !Number.isFinite(expiresAt) || !Number.isFinite(issuedAt) || expiresAt <= now || expiresAt - now > HUB_PHONE_INVITE_MAX_LIFETIME_MS) {
      throw new HubRequestError(400, "Invalid invite.");
    }
    return {
      version: 1, inviteId: invite.inviteId, hubId: invite.hubId, issuerDeviceId: invite.issuerDeviceId, tokenHash: invite.tokenHash,
      scope: invite.scope, name: invite.name, issuedAt: invite.issuedAt!, expiresAt: invite.expiresAt!
    };
  }

  /** A phone shows an invite's token and signs its acceptance with its key:
   *  it is on the roster from then on, as the invite said. One at a time, so
   *  a token is spent once. */
  enroll(value: unknown): Promise<HubPhoneEnrollResponse> {
    const run = this.enrollQueue.then(() => this.enrollNow(value));
    this.enrollQueue = run.catch(() => undefined);
    return run;
  }

  private async enrollNow(value: unknown): Promise<HubPhoneEnrollResponse> {
    const request = value as Partial<HubPhoneEnrollRequest> | undefined;
    const enrollment = request?.enrollment as Partial<HubPhoneEnrollment> | undefined;
    const refused = (message: string) => new HubRequestError(400, message);
    if (!request || typeof request.token !== "string" || !/^[A-Za-z0-9_-]{20,200}$/.test(request.token) || typeof request.signature !== "string" ||
        !enrollment || enrollment.version !== 1 || enrollment.hubId !== this.deps.options.hubId || typeof enrollment.publicKeyDerBase64 !== "string" ||
        enrollment.publicKeyDerBase64.length > 200 || typeof enrollment.deviceId !== "string" || deviceIdForPublicKey(enrollment.publicKeyDerBase64) !== enrollment.deviceId ||
        typeof enrollment.name !== "string" || enrollment.name.length > 100 || CONTROL_CHARACTER.test(enrollment.name) ||
        typeof enrollment.enrolledAt !== "string" || !Number.isFinite(Date.parse(enrollment.enrolledAt))) {
      throw refused("Invalid pairing request.");
    }
    const tokenHash = sha256Hex(request.token);
    if (enrollment.tokenHash !== tokenHash) throw refused("Invalid pairing request.");
    const accepted: HubPhoneEnrollment = {
      version: 1, hubId: enrollment.hubId, tokenHash, deviceId: enrollment.deviceId, publicKeyDerBase64: enrollment.publicKeyDerBase64,
      name: enrollment.name, enrolledAt: enrollment.enrolledAt
    };
    if (!verifyHubText(accepted.publicKeyDerBase64, hubPhoneEnrollmentSigningText(accepted), request.signature)) throw refused("The pairing request's signature does not verify.");
    const hub = this.deps.options.storage.hub();
    const stored = await hub.phoneInviteByTokenHash(tokenHash);
    const gone = new HubRequestError(410, "This pairing code was already used or has expired. Make a new one on your computer.");
    if (!stored || stored.cancelledAt) throw gone;
    const answer = (enrollmentJson: string, enrollmentSignature: string): HubPhoneEnrollResponse => {
      const kept = JSON.parse(enrollmentJson) as HubPhoneEnrollment;
      const certificate: HubPhoneCertificate = {
        invite: stored.invite, inviteSignature: stored.signature, enrollment: kept, enrollmentSignature, token: request.token!
      };
      return { ok: true, hubId: this.deps.options.hubId, deviceId: kept.deviceId, scope: stored.invite.scope, certificate, protocol: HUB_PROTOCOL_VERSION };
    };
    if (stored.usedAt) {
      // The same phone asking again (its answer was lost on the way) is told
      // again; anyone else is refused.
      if (stored.deviceId === accepted.deviceId && stored.enrollment) return answer(stored.enrollment.json, stored.enrollment.signature);
      throw gone;
    }
    const now = new Date(this.deps.now()).toISOString();
    if (Date.parse(stored.invite.expiresAt) <= this.deps.now()) throw gone;
    // Checked as every device checks the certificate later: a phone whose
    // clock is far off is told now, not admitted here and refused elsewhere.
    const enrolledAt = Date.parse(accepted.enrolledAt);
    if (enrolledAt > Date.parse(stored.invite.expiresAt) + HUB_AUTH_MAX_SKEW_MS || enrolledAt < Date.parse(stored.invite.issuedAt) - HUB_AUTH_MAX_SKEW_MS ||
        Math.abs(enrolledAt - this.deps.now()) > HUB_AUTH_MAX_SKEW_MS) {
      throw refused("This phone's clock is off. Set it to update automatically, then scan the code again.");
    }
    const enrollmentJson = JSON.stringify(accepted);
    const taken = await hub.enrollPhone(stored.invite.inviteId, {
      deviceId: accepted.deviceId, publicKeyDerBase64: accepted.publicKeyDerBase64, role: "phone", name: accepted.name || stored.invite.name,
      addedAt: now, scope: stored.invite.scope
    }, { json: enrollmentJson, signature: request.signature }, now);
    if (!taken) throw gone;
    this.server.deviceAuth.invalidateRoster();
    this.deps.options.debugLog?.("hub.phone.enrolled", { deviceId: accepted.deviceId, inviteId: stored.invite.inviteId });
    return answer(enrollmentJson, request.signature);
  }
}

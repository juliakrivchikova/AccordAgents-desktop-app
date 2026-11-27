import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { isDeviceEventBlobReference } from "../../shared/deviceEventBlobs";
import {
  HUB_MAX_BODY_BYTES, HUB_MAX_SMALL_BODY_BYTES, HUB_MEMBER_RULES_PATH, HUB_PLAN_USAGE_PATH, HUB_PLAN_USAGE_REFRESH_PATH, HUB_PROGRESS_PATH, HUB_PROOF_CHALLENGE,
  HUB_PROTOCOL_VERSION, hubPhoneInviteSigningText, hubProofSigningText, type HubHealth, type HubPhoneInvite, type HubProgressPost,
  type HubRosterRequest, type HubRosterResponse
} from "../../shared/hubProtocol";
import { signHubText, verifyHubText } from "../../main/services/hubAuth";
import { isAllowedPushEndpoint } from "../hubPush";
import { HUB_PHONE_PATHS } from "../hubPhone";
import { HUB_MEMBER_RULES_DOCUMENT, HubOpsRequestError } from "../hubOps";
import { HUB_ALERTS_PATH, HUB_ALERTS_TWILIO_PATH } from "../../shared/urgentAlerts";
import { HUB_MEMORY_PATH } from "../../shared/memory";
import { HUB_FEED_PATH, HUB_MACHINE_SETTINGS_PATH, HUB_ME_PATH, HUB_OPS_PATH, type HubMe } from "../../shared/hubOps";
import {
  BLOB_PATH, CONTROL_CHARACTER, ENROLL_MAX_BODY_BYTES, PHONE_UPLOAD_PIN_MS, SLOW_REQUEST_MS, TWILIO_MAX_BODY_BYTES, UPLOAD_PIN_MS
} from "./constants";
import { cors, HubRequestError, json, parseJson, readBody } from "./httpAnswers";
import { blobReference, validInviteIds, validMachineWake, validMemberRules, validRoster } from "./requestChecks";
import type { HubServerModules } from "./modules";
import type { HubServerDependencies } from "./dependencies";

/** Answers each request. */
export class RequestRouter {
  constructor(
    private readonly server: Pick<HubServerModules, "blobFragments" | "deviceAuth" | "deviceRequests" | "liveSockets" | "phoneEnrollment">,
    private readonly deps: Pick<HubServerDependencies, "now" | "options">
  ) {}

  async handle(request: IncomingMessage, response: ServerResponse, openOnly = false): Promise<void> {
    const started = this.deps.now();
    let status = 200;
    let failure: string | undefined;
    try {
      cors(response);
      if (request.method === "OPTIONS") {
        status = 204;
        response.writeHead(204).end();
        return;
      }
      const url = new URL(request.url ?? "/", "http://hub");
      const pathWithQuery = `${url.pathname}${url.search}`;
      if (url.pathname.startsWith("/.well-known/acme-challenge/") && this.deps.options.acmeWebroot) {
        return this.serveChallenge(url.pathname, response);
      }
      if (request.method === "GET" && url.pathname === "/v1/health") {
        const challenge = url.searchParams.get("proof");
        const key = this.deps.options.hubKey;
        const proof = key && challenge && HUB_PROOF_CHALLENGE.test(challenge)
          ? { hubKey: key.publicKeyDerBase64, signature: signHubText(key, hubProofSigningText(this.deps.options.hubId, challenge)) }
          : undefined;
        return json(response, 200, {
          ok: true, protocol: HUB_PROTOCOL_VERSION, hubId: this.deps.options.hubId, version: this.deps.options.version, head: await this.deps.options.ops?.head() ?? 0,
          ...(proof ? { proof } : {})
        } satisfies HubHealth);
      }
      if (request.method === "GET" && url.pathname === "/v1/push/vapid") {
        return json(response, 200, { ok: true, publicKey: this.deps.options.vapidPublicKey });
      }
      if (openOnly) throw new HubRequestError(403, "Use HTTPS.");
      if (this.deps.options.alerts && request.method === "POST" && url.pathname === HUB_ALERTS_TWILIO_PATH) {
        // Unsigned by a device: Twilio signs it with the account's token,
        // which only this server and Twilio hold (HubAlerts checks it).
        const body = await readBody(request, TWILIO_MAX_BODY_BYTES);
        const signature = request.headers["x-twilio-signature"];
        const answer = await this.deps.options.alerts.twilioKey(url, body, typeof signature === "string" ? signature : undefined);
        status = answer.status;
        response.writeHead(answer.status, { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" });
        response.end(answer.twiml);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/phone/enroll") {
        // Unsigned: the phone is not on the roster yet. Its body proves the
        // key it enrolls, and the invite's token proves the owner sent it.
        this.server.phoneEnrollment.limitEnrollments(request.socket.remoteAddress ?? "");
        const body = await readBody(request, ENROLL_MAX_BODY_BYTES);
        return json(response, 200, await this.server.phoneEnrollment.enroll(parseJson(body)));
      }
      // A phone app from before (a mailbox token) is told it was removed, so
      // it asks to be paired again instead of going quiet.
      if (this.deps.options.phone && HUB_PHONE_PATHS.has(url.pathname) && /^Bearer /i.test(request.headers.authorization ?? "")) {
        status = 401;
        return json(response, 401, { ok: false, error: "phone_revoked" });
      }
      const checked = await this.server.deviceAuth.preauthenticate(request.headers.authorization);
      const large = (request.method === "POST" && url.pathname === HUB_OPS_PATH) || (request.method === "PUT" && BLOB_PATH.test(url.pathname)) ||
        (request.method === "PUT" && url.pathname === "/v1/catalog") || (request.method === "POST" && url.pathname === HUB_PROGRESS_PATH) ||
        (request.method === "PUT" && url.pathname === HUB_MEMBER_RULES_PATH) ||
        // A machine's settings carry the User's skills and environment.
        (request.method === "PUT" && url.pathname === HUB_MACHINE_SETTINGS_PATH);
      const body = await readBody(request, large ? HUB_MAX_BODY_BYTES : HUB_MAX_SMALL_BODY_BYTES);
      const device = await this.server.deviceAuth.authenticate(request.method ?? "GET", body, request.headers.authorization, pathWithQuery, checked);
      if (this.deps.options.phone && HUB_PHONE_PATHS.has(url.pathname)) {
        // Only a phone reads the phone's views, as what its invite allowed.
        if (device.role !== "phone") throw new HubRequestError(403, "Only a phone reads this.");
        status = await this.deps.options.phone.handle(request, response, url, device, body);
        return;
      }
      if (request.method === "GET" && url.pathname === HUB_ME_PATH) {
        return json(response, 200, {
          deviceId: device.deviceId, role: device.role, name: device.name, ...(device.machineId ? { machineId: device.machineId } : {})
        } satisfies HubMe);
      }
      if (url.pathname === HUB_MACHINE_SETTINGS_PATH) {
        status = await this.server.deviceRequests.handleMachineSettings(request, response, url, device, body);
        return;
      }
      if (this.deps.options.memory && url.pathname === HUB_MEMORY_PATH) {
        status = await this.server.deviceRequests.handleMemory(request, response, url, device, body);
        return;
      }
      if (this.deps.options.alerts && url.pathname === HUB_ALERTS_PATH) {
        if (request.method !== "POST") throw new HubRequestError(404, "Not found.");
        return json(response, 200, await this.deps.options.alerts.handle(device, parseJson(body)));
      }
      if (this.deps.options.ops && url.pathname.startsWith("/v3/")) {
        status = await this.server.deviceRequests.handleOps(request, response, url, device, body);
        return;
      }
      const blob = BLOB_PATH.exec(url.pathname);
      if (blob) {
        const reference = blobReference(blob[1], url.searchParams);
        const index = Number(url.searchParams.get("index"));
        if (!reference || !Number.isSafeInteger(index) || index < 0 || index >= reference.fragments) throw new HubRequestError(400, "Invalid blob fragment.");
        if (request.method === "PUT") {
          // A body is put up before what names it reaches the server: a
          // phone's picture (it may be offline in between) is kept a month
          // for it, anyone else's (a computer's or a machine's picture, sent
          // right before its message; a catalog's avatar) a day.
          await this.deps.options.storage.deviceEventBlobs().pin([reference.blobHash], device.role === "phone" ? "phone-upload" : "upload",
            this.deps.now() + (device.role === "phone" ? PHONE_UPLOAD_PIN_MS : UPLOAD_PIN_MS));
          await this.server.blobFragments.putBlobFragment(reference, index, body).catch((error: unknown) => {
            throw new HubRequestError(400, error instanceof Error ? error.message : String(error));
          });
          return json(response, 200, { ok: true });
        }
        if (request.method === "GET") {
          const bytes = await this.server.blobFragments.blobFragment(reference, index);
          if (!bytes) throw new HubRequestError(404, "The hub does not hold that fragment.");
          response.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length, "cache-control": "no-store" });
          response.end(bytes);
          return;
        }
      }
      if (request.method === "GET" && url.pathname === "/v1/search") {
        if (device.role === "machine") throw new HubRequestError(403, "Machines do not search the User's chats.");
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const query = url.searchParams.get("q") ?? "";
        if (query.length > 1_000 || CONTROL_CHARACTER.test(query) || (cursor && (cursor.length > 4_096 || CONTROL_CHARACTER.test(cursor)))) {
          throw new HubRequestError(400, "Invalid search.");
        }
        return json(response, 200, await this.deps.options.search.search({ requester: { kind: "user" }, query, ...(cursor ? { cursor } : {}) }));
      }
      if (request.method === "POST" && url.pathname === "/v1/push-subscription") {
        const parsed = parseJson(body) as { subscription?: { endpoint?: unknown } };
        const endpoint = parsed?.subscription?.endpoint;
        if (!isAllowedPushEndpoint(endpoint)) throw new HubRequestError(400, "That push endpoint is not accepted.");
        // Stored as the URL parser wrote it, never as sent.
        const normalized = new URL(endpoint).href;
        const hub = this.deps.options.storage.hub();
        await hub.savePushSubscription(device.deviceId, normalized, JSON.stringify({ ...parsed.subscription, endpoint: normalized }), new Date(this.deps.now()).toISOString());
        // One endpoint is one browser: a phone paired again under a new key
        // is rung once, as itself, not again for the key it had before.
        for (const other of (await hub.pushSubscriptions()).filter((item) => item.endpoint === normalized && item.deviceId !== device.deviceId)) {
          await hub.deletePushSubscription(other.deviceId, other.endpoint);
        }
        return json(response, 200, { ok: true });
      }
      if (url.pathname === "/v1/roster") {
        if (device.role !== "owner") throw new HubRequestError(403, "Only the desktop that set up this hub changes its devices.");
        // With what each phone enrolled: the owner learns a phone that paired
        // while it was away from here, and names it from then on.
        if (request.method === "GET") {
          return json(response, 200, {
            devices: await this.deps.options.storage.hub().devices(),
            enrollments: await this.deps.options.storage.hub().phoneEnrollments(),
            feedReads: [...(await this.deps.options.storage.hubOps().cursorTimes())].map(([deviceId, read]) => ({ deviceId, readAt: read.updatedAt }))
          } satisfies HubRosterResponse);
        }
        if (request.method === "PUT") {
          const parsed = parseJson(body);
          const devices = validRoster(parsed);
          const resolved = validInviteIds((parsed as HubRosterRequest | undefined)?.resolvedInviteIds);
          await this.deps.options.storage.hub().replaceRoster(devices, new Date(this.deps.now()).toISOString(), resolved);
          this.server.deviceAuth.invalidateRoster();
          await this.server.liveSockets.disconnectRemoved();
          return json(response, 200, { devices: await this.deps.options.storage.hub().devices() });
        }
      }
      if (url.pathname === "/v1/phone-invites" && request.method === "PUT") {
        if (device.role !== "owner") throw new HubRequestError(403, "Only the desktop that set up this hub invites phones.");
        const parsed = parseJson(body) as { invite?: HubPhoneInvite; signature?: unknown };
        const invite = this.server.phoneEnrollment.validInvite(parsed?.invite, device);
        if (typeof parsed?.signature !== "string" || !verifyHubText(device.publicKeyDerBase64, hubPhoneInviteSigningText(invite), parsed.signature)) {
          throw new HubRequestError(400, "The invite's signature does not verify.");
        }
        await this.deps.options.storage.hub().savePhoneInvite(invite, parsed.signature, new Date(this.deps.now()).toISOString());
        return json(response, 200, { ok: true, inviteId: invite.inviteId });
      }
      if (url.pathname === "/v1/catalog" && request.method === "PUT") {
        if (device.role !== "owner") throw new HubRequestError(403, "Only the desktop that set up this hub publishes its catalog.");
        const parsed = parseJson(body) as { catalog?: unknown };
        if (!parsed?.catalog || typeof parsed.catalog !== "object") throw new HubRequestError(400, "Invalid catalog.");
        await this.deps.options.storage.hub().setDocument("composer-catalog", parsed.catalog, new Date(this.deps.now()).toISOString());
        // The avatars it names stay on the server while it names them.
        const avatars = Object.values((parsed.catalog as { avatars?: Record<string, { blob?: unknown }> }).avatars ?? {})
          .map((entry) => entry?.blob).filter(isDeviceEventBlobReference).map((blob) => blob.blobHash);
        await this.deps.options.storage.deviceEventBlobs().pinOnly(avatars, "catalog");
        this.deps.options.onCatalogChanged?.();
        return json(response, 200, { ok: true });
      }
      if (url.pathname === HUB_MEMBER_RULES_PATH && request.method === "PUT") {
        if (device.role !== "owner") throw new HubRequestError(403, "Only the desktop that set up this hub publishes the User's rules for members.");
        const rules = validMemberRules(parseJson(body));
        await this.deps.options.storage.hub().setDocument(HUB_MEMBER_RULES_DOCUMENT, rules, new Date(this.deps.now()).toISOString());
        this.deps.options.ops?.memberRulesChanged();
        return json(response, 200, { ok: true });
      }
      if (url.pathname === "/v1/machine-wake" && request.method === "PUT") {
        if (device.role !== "owner") throw new HubRequestError(403, "Only the desktop that set up this hub gives it start keys.");
        const entries = validMachineWake(parseJson(body));
        await this.deps.options.storage.hub().replaceMachineWake(entries.map((entry) => ({ machineId: entry.machineId, configJson: JSON.stringify(entry) })), new Date(this.deps.now()).toISOString());
        return json(response, 200, { ok: true, machines: entries.length });
      }
      if (url.pathname === HUB_PLAN_USAGE_PATH || url.pathname === HUB_PLAN_USAGE_REFRESH_PATH) {
        status = await this.server.deviceRequests.handlePlanUsage(request, response, url, device, body);
        return;
      }
      if (url.pathname === HUB_PROGRESS_PATH && request.method === "POST") {
        // Members run on the computer and on machines; a phone runs nothing.
        if (device.role === "phone") throw new HubRequestError(403, "Only a device that runs members posts their progress.");
        const frames = (parseJson(body) as Partial<HubProgressPost> | undefined)?.frames;
        if (!Array.isArray(frames) || frames.length > 100) throw new HubRequestError(400, "Invalid progress.");
        this.deps.options.onProgress?.(frames);
        return json(response, 200, { ok: true });
      }
      throw new HubRequestError(404, "Not found.");
    } catch (error) {
      status = error instanceof HubRequestError || error instanceof HubOpsRequestError ? error.status : 500;
      if (status !== 500 && error instanceof Error) failure = error.message;
      if (status === 500) this.deps.options.debugLog?.("hub.request.error", { path: (request.url ?? "").split("?")[0], message: error instanceof Error ? error.message : String(error) });
      if (!response.headersSent) json(response, status, { ok: false, error: error instanceof Error && status !== 500 ? error.message : "The hub could not answer." });
    } finally {
      const ms = this.deps.now() - started;
      const path = (request.url ?? "").split("?")[0];
      // A phone's wait for news is long on purpose.
      // Every refusal is logged with its reason, not only failures of the
      // server's own (agreement Д12): a device that cannot write is visible.
      if (status >= 500 || (status >= 400 && path.startsWith("/v3/")) ||
          (ms > SLOW_REQUEST_MS && path !== "/v1/phone/changes" && path !== HUB_FEED_PATH)) {
        this.deps.options.debugLog?.("hub.request", { method: request.method, path, status, ms, ...(failure ? { reason: failure } : {}) });
      }
    }
  }

  private serveChallenge(pathname: string, response: ServerResponse): void {
    const token = pathname.slice("/.well-known/acme-challenge/".length);
    const file = path.join(this.deps.options.acmeWebroot!, ".well-known", "acme-challenge", token);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(token) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(readFileSync(file));
  }
}

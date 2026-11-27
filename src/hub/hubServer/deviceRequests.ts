import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HUB_MAX_BODY_BYTES, HUB_PLAN_USAGE_REFRESH_PATH, type HubDevice, type HubPlanUsageDevice, type HubPlanUsageRefresh, type HubPlanUsageResponse
} from "../../shared/hubProtocol";
import { isPlanUsageProvider, normalizePlanUsageSnapshot } from "../../shared/planUsage";
import type { HubOps } from "../hubOps";
import type { HubMemory } from "../hubMemory";
import { memoryRequestIsPost } from "../../shared/memory";
import {
  HUB_ARTIFACT_PATH, HUB_ARTIFACTS_PATH, HUB_CARDS_PATH, HUB_CHAT_PATH, HUB_CHATS_PATH, HUB_FEED_PATH, HUB_OPS_PATH,
  HUB_TURNS_PATH, type HubCardsResponse, type HubFeedGone, type HubLiveSettings, type HubMachineSettings,
  type HubMachineSettingsPut, type HubTurnsResponse
} from "../../shared/hubOps";
import { HubRequestError, json, parseJson } from "./httpAnswers";
import { MACHINE_ID, machineSettingsKey, planUsageKey, validPlanUsage } from "./requestChecks";
import type { HubServerModules } from "./modules";
import type { HubServerDependencies } from "./dependencies";

/** Operations, members' memory and machine settings. */
export class DeviceRequests {
  constructor(
    private readonly server: Pick<HubServerModules, "liveSockets">,
    private readonly deps: Pick<HubServerDependencies, "now" | "options">
  ) {}

  /** The chats as the server owns them (agreements Д1–Д3): any device on the
   *  roster writes operations and reads the feed and chat pages. */
  async handleOps(request: IncomingMessage, response: ServerResponse, url: URL, device: HubDevice, body: Buffer): Promise<number> {
    const ops = this.deps.options.ops as HubOps;
    if (request.method === "POST" && url.pathname === HUB_OPS_PATH) {
      json(response, 200, await ops.apply(device, parseJson(body)));
      return 200;
    }
    if (request.method === "GET" && url.pathname === HUB_FEED_PATH) {
      const after = Number(url.searchParams.get("after") ?? "0");
      const waitMs = Number(url.searchParams.get("waitMs") ?? "0");
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(waitMs) || waitMs < 0) throw new HubRequestError(400, "Invalid position.");
      const closed = new Promise<void>((resolve) => { request.once("close", () => resolve()); response.once("close", () => resolve()); });
      const answer = await ops.feed(after, waitMs, closed, device.deviceId);
      if ("gone" in answer) {
        this.deps.options.debugLog?.("hub.feed.gone", { deviceId: device.deviceId, after, head: answer.head });
        json(response, 410, { ok: false, error: "The server no longer holds what comes after this place; read the chats again.", gone: true, head: answer.head } satisfies HubFeedGone);
        return 410;
      }
      json(response, 200, answer);
      return 200;
    }
    if (request.method === "GET" && url.pathname === HUB_CHATS_PATH) {
      json(response, 200, await ops.chats());
      return 200;
    }
    if (request.method === "GET" && url.pathname === HUB_CARDS_PATH) {
      const conversationId = url.searchParams.get("conversationId") ?? undefined;
      // The place first: a card that changes while the list is read is never
      // stated as older than the place it is read at.
      const head = await ops.head();
      json(response, 200, { cards: await ops.openCards(conversationId || undefined), head } satisfies HubCardsResponse);
      return 200;
    }
    if (request.method === "GET" && url.pathname === HUB_TURNS_PATH) {
      json(response, 200, { turns: await ops.waitingTurns(device), claimed: await ops.claimedTurns(device), head: await ops.head() } satisfies HubTurnsResponse);
      return 200;
    }
    if (request.method === "GET" && url.pathname === HUB_CHAT_PATH) {
      json(response, 200, await ops.chatPage(url.searchParams.get("conversationId") ?? "", url.searchParams.get("before") ?? undefined));
      return 200;
    }
    // Documents, as the server owns them (Д9): a chat's (without revision
    // bodies), one whole, or one revision's body.
    if (request.method === "GET" && url.pathname === HUB_ARTIFACTS_PATH) {
      json(response, 200, await ops.artifactStates(url.searchParams.get("conversationId") ?? ""));
      return 200;
    }
    if (request.method === "GET" && url.pathname === HUB_ARTIFACT_PATH) {
      const artifactId = url.searchParams.get("artifactId") ?? "";
      const revision = url.searchParams.get("revision");
      json(response, 200, revision ? await ops.artifactRevision(artifactId, revision) : await ops.artifactState(artifactId));
      return 200;
    }
    throw new HubRequestError(404, "Not found.");
  }

  /** Members' memory: a read as GET (`?request=` the request as JSON), a
   *  change as POST; the answer says what the rules decided. */
  async handleMemory(request: IncomingMessage, response: ServerResponse, url: URL, device: HubDevice, body: Buffer): Promise<number> {
    const memory = this.deps.options.memory as HubMemory;
    let parsed: unknown;
    if (request.method === "GET") {
      const text = url.searchParams.get("request") ?? "";
      try { parsed = JSON.parse(text) as unknown; } catch { throw new HubRequestError(400, "Invalid memory request."); }
      const asked = parsed as { action?: unknown; text?: unknown } | undefined;
      // A key or a message's text never comes in an address (logs keep those).
      if (typeof asked?.action !== "string" || memoryRequestIsPost({ action: asked.action, text: asked.text })) {
        throw new HubRequestError(400, "A change to memory is a POST.");
      }
    } else if (request.method === "POST") {
      parsed = parseJson(body);
    } else {
      throw new HubRequestError(404, "Not found.");
    }
    json(response, 200, await memory.handle(device, parsed));
    return 200;
  }

  /**
   * A machine's settings, sealed for it by the computer that set it up: the
   * owner puts them, the machine reads its own (by the machine id the roster
   * gives it). The server keeps the sealed text and never opens it; a put is
   * told to the machine at once on its live socket.
   */
  async handleMachineSettings(request: IncomingMessage, response: ServerResponse, url: URL, device: HubDevice, body: Buffer): Promise<number> {
    const hub = this.deps.options.storage.hub();
    if (request.method === "PUT") {
      if (device.role !== "owner") throw new HubRequestError(403, "Only the desktop that set up this hub publishes a machine's settings.");
      const parsed = parseJson(body) as Partial<HubMachineSettingsPut> | undefined;
      if (!parsed || typeof parsed.machineId !== "string" || !MACHINE_ID.test(parsed.machineId) ||
          typeof parsed.sealed !== "string" || parsed.sealed.length === 0 || parsed.sealed.length > HUB_MAX_BODY_BYTES) {
        throw new HubRequestError(400, "Invalid machine settings.");
      }
      const updatedAt = new Date(this.deps.now()).toISOString();
      await hub.setDocument(machineSettingsKey(parsed.machineId), { sealed: parsed.sealed, updatedAt }, updatedAt);
      void this.server.liveSockets.tellMachine(parsed.machineId, { type: "settings" } satisfies HubLiveSettings);
      this.deps.options.debugLog?.("hub.machine-settings.published", { machineId: parsed.machineId, bytes: parsed.sealed.length });
      json(response, 200, { ok: true, updatedAt });
      return 200;
    }
    if (request.method === "GET") {
      if (device.role !== "machine" || !device.machineId) throw new HubRequestError(403, "Only a machine reads its settings, and only its own.");
      const stored = (await hub.document(machineSettingsKey(device.machineId)))?.value as { sealed?: unknown; updatedAt?: unknown } | undefined;
      const sealed = typeof stored?.sealed === "string" ? stored.sealed : undefined;
      const updatedAt = typeof stored?.updatedAt === "string" ? stored.updatedAt : undefined;
      const since = url.searchParams.get("since") ?? undefined;
      if (sealed && updatedAt && since && updatedAt <= since) {
        json(response, 200, { updatedAt, unchanged: true } satisfies HubMachineSettings);
        return 200;
      }
      json(response, 200, (sealed && updatedAt ? { sealed, updatedAt } : {}) satisfies HubMachineSettings);
      return 200;
    }
    throw new HubRequestError(404, "Not found.");
  }

  /** Puts of plan usage, one at a time (each merges into what is stored). */
  private planUsageWrites: Promise<unknown> = Promise.resolve();

  /**
   * Plan usage (HUB_PLAN_USAGE_PATH): a device that runs members puts its
   * own, the computer (and a phone that reads every chat) reads every
   * device's and asks a machine to read its own again, told on its live
   * socket; the answer says whether the machine was there to take it. The
   * last value of each CLI only.
   */
  async handlePlanUsage(request: IncomingMessage, response: ServerResponse, url: URL, device: HubDevice, body: Buffer): Promise<number> {
    const hub = this.deps.options.storage.hub();
    // A phone reads only with the device-wide scope it reads every chat with.
    const reads = device.role !== "machine" && (device.role !== "phone" || device.scope?.scope === "device");
    if (url.pathname === HUB_PLAN_USAGE_REFRESH_PATH) {
      if (request.method !== "POST") throw new HubRequestError(404, "Not found.");
      if (!reads) throw new HubRequestError(403, "This device does not ask machines for their usage.");
      const parsed = parseJson(body) as Partial<HubPlanUsageRefresh> | undefined;
      if (typeof parsed?.machineId !== "string" || !MACHINE_ID.test(parsed.machineId) || !isPlanUsageProvider(parsed.provider)) {
        throw new HubRequestError(400, "Invalid plan usage refresh.");
      }
      const sent = await this.server.liveSockets.tellMachine(parsed.machineId,
        { type: "plan-usage-refresh", provider: parsed.provider, ...(parsed.force === true ? { force: true } : {}) });
      json(response, 200, { ok: true, delivered: sent > 0 });
      return 200;
    }
    if (request.method === "PUT") {
      if (device.role === "phone") throw new HubRequestError(403, "Only a device that runs members puts their usage.");
      const snapshots = validPlanUsage(parseJson(body));
      const updatedAt = new Date(this.deps.now()).toISOString();
      // The CLIs it put replace their own last value; the others it read
      // before (a CLI not read since it restarted) stay.
      const write = this.planUsageWrites.then(async () => {
        const stored = (await hub.document(planUsageKey(device.deviceId)))?.value as { snapshots?: unknown } | undefined;
        const kept = (Array.isArray(stored?.snapshots) ? stored.snapshots : []).map(normalizePlanUsageSnapshot)
          .filter((snapshot) => snapshot !== undefined && !snapshots.some((item) => item.provider === snapshot.provider));
        await hub.setDocument(planUsageKey(device.deviceId), { snapshots: [...kept, ...snapshots], updatedAt }, updatedAt);
      });
      this.planUsageWrites = write.catch(() => undefined);
      await write;
      this.server.liveSockets.broadcast({ type: "plan-usage", deviceId: device.deviceId });
      json(response, 200, { ok: true });
      return 200;
    }
    if (request.method === "GET") {
      if (!reads) throw new HubRequestError(403, "This device does not read other devices' usage.");
      const devices: HubPlanUsageDevice[] = [];
      for (const item of await hub.devices()) {
        if (item.role === "phone") continue;
        const stored = (await hub.document(planUsageKey(item.deviceId)))?.value as { snapshots?: unknown; updatedAt?: unknown } | undefined;
        if (!stored || typeof stored.updatedAt !== "string" || !Array.isArray(stored.snapshots)) continue;
        const snapshots = stored.snapshots.map(normalizePlanUsageSnapshot).filter((snapshot) => snapshot !== undefined);
        devices.push({ deviceId: item.deviceId, ...(item.machineId ? { machineId: item.machineId } : {}), snapshots, updatedAt: stored.updatedAt });
      }
      json(response, 200, { devices } satisfies HubPlanUsageResponse);
      return 200;
    }
    throw new HubRequestError(404, "Not found.");
  }
}

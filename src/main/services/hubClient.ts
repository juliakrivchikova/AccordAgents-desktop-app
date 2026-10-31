import { BLOB_FRAGMENT_MAX_BYTES, isDeviceEventBlobReference, type DeviceEventBlobReference } from "../../shared/deviceEventBlobs";
import {
  HUB_PROGRESS_PATH, hubBlobFragmentPath, hubWebSocketUrl,
  type HubComposerCatalog, type HubDevice, type HubHealth, type HubMachineWakeRequest, type HubPhoneInvite, type HubProgressPost, type HubRosterResponse
} from "../../shared/hubProtocol";
import type { MachineProgressFrame } from "../../shared/machineProgress";
import {
  HUB_ARTIFACT_PATH,
  HUB_ARTIFACTS_PATH,
  HUB_CARDS_PATH,
  HUB_CHAT_PATH,
  HUB_CHATS_PATH,
  HUB_FEED_PATH,
  HUB_MACHINE_SETTINGS_PATH,
  HUB_ME_PATH,
  HUB_OPS_PATH,
  HUB_TURNS_PATH,
  type HubArtifactResponse,
  type HubArtifactRevisionResponse,
  type HubArtifactsResponse,
  type HubCardsResponse,
  type HubChatPage,
  type HubChatsResponse,
  type HubFeedResponse,
  type HubMachineSettings,
  type HubMachineSettingsPut,
  type HubMe,
  type HubOp,
  type HubOpsResponse,
  type HubTurnsResponse
} from "../../shared/hubOps";
import { sha256Hex, signHubRequest, type HubSigningIdentity } from "./hubAuth";

const REQUEST_TIMEOUT_MS = 30_000;
/** Writing a large page (a chat moving to the server) takes longer. */
const OPS_TIMEOUT_MS = 120_000;

/** The little of a WebSocket the live link uses. */
interface LiveSocket {
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onopen: (() => void) | null;
  close(): void;
  /** `ws` only: a link that stops answering pings is dead even when no
   *  close ever arrives (a laptop that slept, a changed network). */
  ping?(): void;
  terminate?(): void;
  on?(event: "pong", listener: () => void): unknown;
}
/** A live link pings this often and is given up when a ping goes unanswered. */
const LIVE_PING_MS = 25_000;
/** `ws`, not a global: Electron's Node has no WebSocket of its own. */
const WebSocketClient = require("ws") as new (url: string) => LiveSocket;

export class HubHttpError extends Error {
  constructor(readonly status: number, message: string, readonly detail: Record<string, unknown> = {}) {
    super(message);
  }
}

/** The hub or the network was not there (no answer, a timeout): nothing is
 *  known about the request, which is tried again later. */
export class HubTransientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HubTransientError";
  }
}

/** A fetch that did not get an answer becomes a HubTransientError; an answer,
 *  whatever it says, is returned. */
async function reach(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    throw new HubTransientError(`The hub could not be reached: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * Talks to the User's hub as one device: signed requests, the chats as the
 * server owns them (operations, the feed, chat pages, turns, cards,
 * documents), the roster and the phone's pairing, bodies (pictures, avatars),
 * and the live word that the feed moved.
 */
export class HubClient {
  private readonly base: string;
  /** Response bytes read from the hub so far (as their length says). */
  receivedBytes = 0;

  constructor(private readonly options: {
    url: string;
    identity: () => Promise<HubSigningIdentity>;
    fetchImpl?: typeof fetch;
    createSocket?: (url: string) => LiveSocket;
  }) {
    this.base = options.url.replace(/\/+$/, "");
  }

  private async request<T>(method: string, pathWithQuery: string, body?: Buffer | string, contentType?: string, timeoutMs = REQUEST_TIMEOUT_MS, cancel?: AbortSignal): Promise<T> {
    const identity = await this.options.identity();
    const response = await reach(this.options.fetchImpl ?? fetch, `${this.base}${pathWithQuery}`, {
      method,
      headers: {
        authorization: signHubRequest(identity, { method, pathWithQuery, body: body ?? "" }),
        ...(contentType ? { "content-type": contentType } : {})
      },
      ...(body !== undefined ? { body } : {}),
      signal: cancel ? AbortSignal.any([AbortSignal.timeout(timeoutMs), cancel]) : AbortSignal.timeout(timeoutMs)
    });
    this.receivedBytes += Number(response.headers.get("content-length")) || 0;
    if (!response.ok) {
      const detail = await response.json().catch(() => ({})) as { error?: string } & Record<string, unknown>;
      throw new HubHttpError(response.status, detail.error || `The hub answered ${response.status}.`, detail);
    }
    return await response.json() as T;
  }

  async health(): Promise<HubHealth> {
    const response = await reach(this.options.fetchImpl ?? fetch, `${this.base}/v1/health`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new HubHttpError(response.status, `The hub answered ${response.status}.`);
    return await response.json() as HubHealth;
  }

  // --- the chats as the server owns them (protocol v3) ---------------------

  /** Writes operations; each is answered accepted, duplicate or rejected. */
  writeOps(ops: HubOp[]): Promise<HubOpsResponse> {
    return this.request<HubOpsResponse>("POST", HUB_OPS_PATH, JSON.stringify({ ops }), "application/json", OPS_TIMEOUT_MS);
  }

  /** What the server accepted after `after`, waiting up to `waitMs` for news.
   *  A HubHttpError with status 410 says it was forgotten (read the chats). */
  feed(after: number, waitMs: number, cancel?: AbortSignal): Promise<HubFeedResponse> {
    return this.request<HubFeedResponse>("GET", `${HUB_FEED_PATH}?after=${Math.max(0, Math.floor(after))}&waitMs=${Math.max(0, Math.floor(waitMs))}`,
      undefined, undefined, waitMs + REQUEST_TIMEOUT_MS, cancel);
  }

  chats(): Promise<HubChatsResponse> {
    return this.request<HubChatsResponse>("GET", HUB_CHATS_PATH);
  }

  chatPage(conversationId: string, before?: string): Promise<HubChatPage> {
    const query = new URLSearchParams({ conversationId, ...(before ? { before } : {}) });
    return this.request<HubChatPage>("GET", `${HUB_CHAT_PATH}?${query.toString()}`);
  }

  /** A chat's documents as the server holds them, without revision bodies. */
  artifacts(conversationId: string): Promise<HubArtifactsResponse> {
    return this.request<HubArtifactsResponse>("GET", `${HUB_ARTIFACTS_PATH}?${new URLSearchParams({ conversationId }).toString()}`, undefined, undefined, OPS_TIMEOUT_MS);
  }

  /** One document; a HubHttpError with status 404 when the server has none. */
  artifact(artifactId: string): Promise<HubArtifactResponse> {
    return this.request<HubArtifactResponse>("GET", `${HUB_ARTIFACT_PATH}?${new URLSearchParams({ artifactId }).toString()}`);
  }

  /** One revision's body (a revision never changes). */
  artifactRevision(artifactId: string, versionEventId: string): Promise<HubArtifactRevisionResponse> {
    return this.request<HubArtifactRevisionResponse>("GET", `${HUB_ARTIFACT_PATH}?${new URLSearchParams({ artifactId, revision: versionEventId }).toString()}`,
      undefined, undefined, OPS_TIMEOUT_MS);
  }

  waitingTurns(): Promise<HubTurnsResponse> {
    return this.request<HubTurnsResponse>("GET", HUB_TURNS_PATH);
  }

  /** Cards not settled yet, in one chat or every chat, oldest first. */
  openCards(conversationId?: string): Promise<HubCardsResponse> {
    return this.request<HubCardsResponse>("GET", `${HUB_CARDS_PATH}${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ""}`);
  }

  /** This device as the server's roster has it (a machine: its machine id). */
  me(): Promise<HubMe> {
    return this.request<HubMe>("GET", HUB_ME_PATH);
  }

  /** The owner: a machine's settings, sealed for that machine. */
  putMachineSettings(request: HubMachineSettingsPut): Promise<{ ok: boolean; updatedAt: string }> {
    return this.request("PUT", HUB_MACHINE_SETTINGS_PATH, JSON.stringify(request), "application/json", OPS_TIMEOUT_MS);
  }

  /** A machine: its own settings, unless they are no newer than `since`. */
  machineSettings(since?: string): Promise<HubMachineSettings> {
    return this.request<HubMachineSettings>("GET", `${HUB_MACHINE_SETTINGS_PATH}${since ? `?since=${encodeURIComponent(since)}` : ""}`,
      undefined, undefined, OPS_TIMEOUT_MS);
  }

  /** The owner only: the roster as the server holds it, with what each
   *  phone that paired with an invite enrolled with. */
  roster(): Promise<HubRosterResponse> {
    return this.request<HubRosterResponse>("GET", "/v1/roster");
  }

  setRoster(devices: Array<Omit<HubDevice, "addedAt">>, resolvedInviteIds?: string[]): Promise<{ devices: HubDevice[] }> {
    return this.request("PUT", "/v1/roster", JSON.stringify({ devices, ...(resolvedInviteIds ? { resolvedInviteIds } : {}) }), "application/json");
  }

  /** Registers a phone invite this desktop signed (owner only). */
  putPhoneInvite(invite: HubPhoneInvite, signature: string): Promise<{ ok: boolean; inviteId: string }> {
    return this.request("PUT", "/v1/phone-invites", JSON.stringify({ invite, signature }), "application/json");
  }

  /** The composer's catalog the phone reads (owner only). */
  setCatalog(catalog: HubComposerCatalog): Promise<{ ok: boolean }> {
    return this.request("PUT", "/v1/catalog", JSON.stringify({ catalog }), "application/json");
  }

  /** This desktop's members' live progress, for the phone to show while
   *  they run (held in the hub's memory only). */
  postProgress(frames: MachineProgressFrame[]): Promise<{ ok: boolean }> {
    return this.request("POST", HUB_PROGRESS_PATH, JSON.stringify({ frames } satisfies HubProgressPost), "application/json");
  }

  /** The start-only keys the hub may wake the machines with (owner only). */
  setMachineWake(machines: HubMachineWakeRequest["machines"]): Promise<{ ok: boolean; machines: number }> {
    return this.request("PUT", "/v1/machine-wake", JSON.stringify({ machines } satisfies HubMachineWakeRequest), "application/json");
  }

  /** Puts bytes on the hub as a body (a picture, an avatar) that a message
   *  or the catalog names by its reference; fragments already there are sent
   *  again harmlessly. `reference`: the bytes' name, when the caller has
   *  it already (it is not worked out again). */
  async uploadBytes(bytes: Buffer, reference: DeviceEventBlobReference = blobReferenceOf(bytes)): Promise<DeviceEventBlobReference> {
    for (let index = 0; index < reference.fragments; index += 1) {
      const part = bytes.subarray(index * BLOB_FRAGMENT_MAX_BYTES, Math.min(bytes.length, (index + 1) * BLOB_FRAGMENT_MAX_BYTES));
      await this.request("PUT", hubBlobFragmentPath(reference, index), part, "application/octet-stream");
    }
    return reference;
  }

  /** Reads a blob's bytes from the hub (a picture a phone posted). */
  async downloadBytes(reference: DeviceEventBlobReference): Promise<Buffer> {
    if (!isDeviceEventBlobReference(reference)) throw new Error("Not a blob reference.");
    const identity = await this.options.identity();
    const parts: Buffer[] = [];
    for (let index = 0; index < reference.fragments; index += 1) {
      const pathWithQuery = hubBlobFragmentPath(reference, index);
      const response = await reach(this.options.fetchImpl ?? fetch, `${this.base}${pathWithQuery}`, {
        headers: { authorization: signHubRequest(identity, { method: "GET", pathWithQuery }) },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!response.ok) throw new HubHttpError(response.status, `The hub could not give a fragment (${response.status}).`);
      parts.push(Buffer.from(await response.arrayBuffer()));
    }
    const bytes = Buffer.concat(parts);
    if (`sha256:${sha256Hex(bytes)}` !== reference.blobHash || bytes.length !== reference.byteLength) throw new Error("The hub's copy of that body does not match its name.");
    return bytes;
  }

  /**
   * Keeps a live link to the hub (it says when the feed moved, and that a
   * machine's settings changed); reconnects with backoff. Returns a function
   * that closes it for good.
   */
  live(onState?: (connected: boolean) => void, onFrame?: (frame: { type: string } & Record<string, unknown>) => void): () => void {
    let closed = false;
    let socket: LiveSocket | undefined;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const connect = async (): Promise<void> => {
      if (closed) return;
      try {
        const identity = await this.options.identity();
        const auth = signHubRequest(identity, { method: "GET", pathWithQuery: "/v1/live" });
        const url = hubWebSocketUrl(this.base, `/v1/live?auth=${encodeURIComponent(auth)}`);
        const created = this.options.createSocket?.(url) ?? new WebSocketClient(url);
        socket = created;
        let answered = true;
        created.on?.("pong", () => { answered = true; });
        created.onopen = () => {
          attempt = 0;
          onState?.(true);
          if (!created.ping) return;
          heartbeat = setInterval(() => {
            if (!answered) {
              // Gone without a close: give it up, which reconnects.
              (created.terminate ?? created.close).call(created);
              return;
            }
            answered = false;
            try { created.ping?.(); } catch { (created.terminate ?? created.close).call(created); }
          }, LIVE_PING_MS);
          heartbeat.unref?.();
        };
        created.onmessage = (event) => {
          try {
            const frame = JSON.parse(String(event.data)) as { type: string } & Record<string, unknown>;
            if (frame && typeof frame.type === "string") onFrame?.(frame);
          } catch { /* a malformed frame is ignored */ }
        };
        created.onerror = () => undefined;
        created.onclose = () => {
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = undefined;
          if (socket !== created) return;
          socket = undefined;
          onState?.(false);
          schedule();
        };
      } catch {
        schedule();
      }
    };
    const schedule = (): void => {
      if (closed || timer) return;
      const delay = Math.min(30_000, 1_000 * 2 ** attempt) * (0.75 + Math.random() / 2);
      attempt = Math.min(attempt + 1, 6);
      timer = setTimeout(() => {
        timer = undefined;
        void connect();
      }, delay);
      timer.unref?.();
    };
    void connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      socket?.close();
    };
  }
}

/** The name bytes are kept under on the User's server: their content, so a
 *  device names a picture in its message before (and whether or not) the
 *  bytes were put there, and every device names the same bytes alike. */
export function blobReferenceOf(bytes: Buffer): DeviceEventBlobReference {
  return {
    type: "device.event.blob",
    blobHash: `sha256:${sha256Hex(bytes)}`,
    byteLength: bytes.length,
    fragments: Math.max(1, Math.ceil(bytes.length / BLOB_FRAGMENT_MAX_BYTES))
  };
}

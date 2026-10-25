import { isDeviceEventBlobReference } from "../../shared/deviceEventBlobs";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import {
  HUB_PULL_MAX_EVENTS, hubBlobFragmentPath, hubWebSocketUrl,
  type HubChainResponse, type HubDevice, type HubEventPullResponse, type HubEventPushResponse, type HubHealth, type HubKnownDevicesResponse,
  type HubLiveHead, type HubReadReport, type HubReadersResponse, type HubSnapshotResponse
} from "../../shared/hubProtocol";
import { signHubRequest, type HubSigningIdentity } from "./hubAuth";
import type { StorageService } from "./storage";

const REQUEST_TIMEOUT_MS = 30_000;

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

/** The hub forgot events this device would need after its position: the
 *  device starts again from the hub's copy (HubSync.resync). */
export function isHubResyncRequired(error: unknown): error is HubHttpError {
  return error instanceof HubHttpError && error.status === 410 && error.detail.resync === true;
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
 * Talks to the User's hub as one device: signed requests, the device's own
 * events pushed (blob fragments first), the order read back from a position,
 * and the live head the hub announces.
 */
export class HubClient {
  private readonly base: string;
  /** Response bytes read from the hub so far (as their length says). */
  receivedBytes = 0;

  constructor(private readonly options: {
    url: string;
    identity: () => Promise<HubSigningIdentity>;
    storage: Pick<StorageService, "deviceEventBlobs">;
    fetchImpl?: typeof fetch;
    createSocket?: (url: string) => LiveSocket;
  }) {
    this.base = options.url.replace(/\/+$/, "");
  }

  private async request<T>(method: string, pathWithQuery: string, body?: Buffer | string, contentType?: string): Promise<T> {
    const identity = await this.options.identity();
    const response = await reach(this.options.fetchImpl ?? fetch, `${this.base}${pathWithQuery}`, {
      method,
      headers: {
        authorization: signHubRequest(identity, { method, pathWithQuery, body: body ?? "" }),
        ...(contentType ? { "content-type": contentType } : {})
      },
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
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

  /** Pushes this device's events in order. A large body is uploaded only
   *  when the hub answers that it lacks it (`uploadBlob`). */
  push(events: ChatEventEnvelope[], options: { anchor?: string[] } = {}): Promise<HubEventPushResponse> {
    return this.request<HubEventPushResponse>("POST", "/v1/events", JSON.stringify({ events, ...(options.anchor?.length ? { anchor: options.anchor } : {}) }), "application/json");
  }

  /** Uploads the fragments of one event's large body; false when this
   *  device no longer holds them. */
  async uploadBlob(event: ChatEventEnvelope): Promise<boolean> {
    if (!isDeviceEventBlobReference(event.payload)) return true;
    const reference = event.payload;
    for (let index = 0; index < reference.fragments; index += 1) {
      // Gone (never kept, or spoiled) is final; any other read failure is
      // not, and fails the push to be tried again.
      const fragment = await this.options.storage.deviceEventBlobs().fragment(reference, index).catch((error: unknown) => {
        if (error instanceof Error && /corrupt/i.test(error.message)) return undefined;
        throw error;
      });
      if (!fragment) return false;
      await this.request("PUT", hubBlobFragmentPath(reference, index), Buffer.from(fragment.bytesBase64, "base64"), "application/octet-stream");
    }
    return true;
  }

  /** The order after `after`. With `report` (what this device holds) the
   *  hub keeps what it still needs, and answers 410 when it no longer has
   *  it (isHubResyncRequired); `peek` reads without moving this device's place. */
  pull(after: number, limit = HUB_PULL_MAX_EVENTS, report?: HubReadReport & { peek?: boolean }): Promise<HubEventPullResponse> {
    const reported = report
      ? `&held=${Math.max(0, Math.floor(report.held))}&heldSince=${Math.max(0, Math.floor(report.heldSince))}&heldCount=${Math.max(0, Math.floor(report.heldCount))}${report.peek ? "&peek=1" : ""}`
      : "";
    return this.request<HubEventPullResponse>("GET", `/v1/events?after=${after}&limit=${limit}${reported}`);
  }

  /** Where to start reading again (and, with `copy`, the hub's copy of the
   *  chats), one page per call; see HubSnapshotResponse. */
  snapshot(request: { page?: string; scopes?: readonly string[]; atMost?: number; since?: number; copy: boolean; chat?: string }): Promise<HubSnapshotResponse> {
    const params = new URLSearchParams();
    params.set("copy", request.copy ? "1" : "0");
    if (request.chat) params.set("chat", request.chat);
    if (request.page) params.set("page", request.page);
    if (request.scopes?.length) params.set("scopes", request.scopes.join(","));
    if (request.atMost !== undefined) params.set("atMost", String(Math.max(0, Math.floor(request.atMost))));
    if (request.since !== undefined) params.set("since", String(Math.max(0, Math.floor(request.since))));
    return this.request<HubSnapshotResponse>("GET", `/v1/snapshot?${params.toString()}`);
  }

  /** One chain's events in a range (a gap this device found). */
  chain(originId: string, logScopeId: string, fromSeq: number, toSeq: number): Promise<HubChainResponse> {
    const params = new URLSearchParams({ origin: originId, scope: logScopeId, from: String(fromSeq), to: String(toSeq) });
    return this.request<HubChainResponse>("GET", `/v1/chain?${params.toString()}`);
  }

  /** Which of these devices are on the roster now. */
  known(deviceIds: readonly string[]): Promise<HubKnownDevicesResponse> {
    return this.request<HubKnownDevicesResponse>("GET", `/v1/devices/known?ids=${deviceIds.map(encodeURIComponent).join(",")}`);
  }

  /** The owner only: every reader, where it stands and what it holds. */
  readers(): Promise<HubReadersResponse> {
    return this.request<HubReadersResponse>("GET", "/v1/readers");
  }

  /** Stores a pulled event's large body locally before the event is applied
   *  (nothing to fetch when this device holds it already). */
  async fetchBlob(event: ChatEventEnvelope): Promise<void> {
    if (!isDeviceEventBlobReference(event.payload)) return;
    const reference = event.payload;
    if (await this.options.storage.deviceEventBlobs().verify(reference).catch(() => false)) return;
    const identity = await this.options.identity();
    for (let index = 0; index < reference.fragments; index += 1) {
      const pathWithQuery = hubBlobFragmentPath(reference, index);
      const response = await reach(this.options.fetchImpl ?? fetch, `${this.base}${pathWithQuery}`, {
        headers: { authorization: signHubRequest(identity, { method: "GET", pathWithQuery }) },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!response.ok) throw new HubHttpError(response.status, `The hub could not give a fragment (${response.status}).`);
      const bytes = Buffer.from(await response.arrayBuffer());
      this.receivedBytes += bytes.length;
      await this.options.storage.deviceEventBlobs().store({ reference, index, bytesBase64: bytes.toString("base64") });
    }
  }

  /** The phone links this desktop knows (their mailbox ids): the server
   *  serves chats to those only. */
  setPhoneLinks(mailboxIds: string[]): Promise<{ ok: boolean; known: number }> {
    return this.request("PUT", "/v1/phone-links", JSON.stringify({ mailboxIds }), "application/json");
  }

  setRoster(devices: Array<Omit<HubDevice, "addedAt">>): Promise<{ devices: HubDevice[] }> {
    return this.request("PUT", "/v1/roster", JSON.stringify({ devices }), "application/json");
  }

  /**
   * Keeps a live link that reports the hub's head; reconnects with backoff.
   * Returns a function that closes it for good.
   */
  live(onHead: (head: number) => void, onState?: (connected: boolean) => void): () => void {
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
            const frame = JSON.parse(String(event.data)) as HubLiveHead;
            if (frame.type === "head" && Number.isSafeInteger(frame.head)) onHead(frame.head);
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

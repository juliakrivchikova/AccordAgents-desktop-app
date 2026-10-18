import { isDeviceEventBlobReference } from "../../shared/deviceEventBlobs";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { HubDevice, HubEventPullResponse, HubEventPushResponse, HubHealth, HubLiveHead } from "../../shared/hubProtocol";
import { signHubRequest, type HubSigningIdentity } from "./hubAuth";
import type { StorageService } from "./storage";

const REQUEST_TIMEOUT_MS = 30_000;

/** The little of a WebSocket the live link uses (Node 22's global one, or `ws`). */
interface LiveSocket {
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onopen: (() => void) | null;
  close(): void;
}

export class HubHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Talks to the User's hub as one device: signed requests, the device's own
 * events pushed (blob fragments first), the order read back from a position,
 * and the live head the hub announces.
 */
export class HubClient {
  private readonly base: string;

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
    const response = await (this.options.fetchImpl ?? fetch)(`${this.base}${pathWithQuery}`, {
      method,
      headers: {
        authorization: signHubRequest(identity, { method, pathWithQuery, body: body ?? "" }),
        ...(contentType ? { "content-type": contentType } : {})
      },
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({})) as { error?: string };
      throw new HubHttpError(response.status, detail.error || `The hub answered ${response.status}.`);
    }
    return await response.json() as T;
  }

  async health(): Promise<HubHealth> {
    const response = await (this.options.fetchImpl ?? fetch)(`${this.base}/v1/health`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new HubHttpError(response.status, `The hub answered ${response.status}.`);
    return await response.json() as HubHealth;
  }

  /** Pushes this device's events in order; a large payload's fragments go first. */
  async push(events: ChatEventEnvelope[]): Promise<HubEventPushResponse> {
    for (const event of events) {
      if (!isDeviceEventBlobReference(event.payload)) continue;
      const reference = event.payload;
      for (let index = 0; index < reference.fragments; index += 1) {
        const fragment = await this.options.storage.deviceEventBlobs().fragment(reference, index);
        if (!fragment) throw new Error("A large event body is missing a fragment on this device.");
        const pathWithQuery = `/v1/blobs/${reference.blobHash}?bytes=${reference.byteLength}&fragments=${reference.fragments}&index=${index}`;
        await this.request("PUT", pathWithQuery, Buffer.from(fragment.bytesBase64, "base64"), "application/octet-stream");
      }
    }
    return this.request<HubEventPushResponse>("POST", "/v1/events", JSON.stringify({ events }), "application/json");
  }

  pull(after: number, limit = 200): Promise<HubEventPullResponse> {
    return this.request<HubEventPullResponse>("GET", `/v1/events?after=${after}&limit=${limit}`);
  }

  /** Stores a pulled event's large body locally before the event is applied. */
  async fetchBlob(event: ChatEventEnvelope): Promise<void> {
    if (!isDeviceEventBlobReference(event.payload)) return;
    const reference = event.payload;
    const identity = await this.options.identity();
    for (let index = 0; index < reference.fragments; index += 1) {
      const pathWithQuery = `/v1/blobs/${reference.blobHash}?bytes=${reference.byteLength}&fragments=${reference.fragments}&index=${index}`;
      const response = await (this.options.fetchImpl ?? fetch)(`${this.base}${pathWithQuery}`, {
        headers: { authorization: signHubRequest(identity, { method: "GET", pathWithQuery }) },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!response.ok) throw new HubHttpError(response.status, `The hub could not give a fragment (${response.status}).`);
      const bytes = Buffer.from(await response.arrayBuffer());
      await this.options.storage.deviceEventBlobs().store({ reference, index, bytesBase64: bytes.toString("base64") });
    }
  }

  setRoster(devices: Array<Omit<HubDevice, "addedAt">>): Promise<{ devices: HubDevice[] }> {
    return this.request("PUT", "/v1/roster", JSON.stringify({ devices }), "application/json");
  }

  roster(): Promise<{ devices: HubDevice[] }> {
    return this.request("GET", "/v1/roster");
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
    const connect = async (): Promise<void> => {
      if (closed) return;
      try {
        const identity = await this.options.identity();
        const auth = signHubRequest(identity, { method: "GET", pathWithQuery: "/v1/live" });
        const url = `${this.base.replace(/^http/, "ws")}/v1/live?auth=${encodeURIComponent(auth)}`;
        const created = this.options.createSocket?.(url) ?? (new (globalThis as unknown as { WebSocket: new (url: string) => LiveSocket }).WebSocket(url));
        socket = created;
        created.onopen = () => {
          attempt = 0;
          onState?.(true);
        };
        created.onmessage = (event) => {
          try {
            const frame = JSON.parse(String(event.data)) as HubLiveHead;
            if (frame.type === "head" && Number.isSafeInteger(frame.head)) onHead(frame.head);
          } catch { /* a malformed frame is ignored */ }
        };
        created.onerror = () => undefined;
        created.onclose = () => {
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
      socket?.close();
    };
  }
}

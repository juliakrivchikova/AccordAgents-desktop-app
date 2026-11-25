import { HUB_AUTH_MAX_SKEW_MS, type HubDevice } from "../../shared/hubProtocol";
import { HubNonceCache, parseHubAuthorization, verifyHubRequest, type ParsedHubAuthorization } from "../../main/services/hubAuth";
import { HUB_NOT_ON_ROSTER } from "./constants";
import { HubRequestError } from "./httpAnswers";
import type { HubServerDependencies } from "./dependencies";

/** Who is asking: every device signs what it sends. */
export class DeviceAuth {
  private readonly nonces = new HubNonceCache();
  private roster?: Promise<Map<string, HubDevice>>;
  private rosterReadAt = 0;

  constructor(private readonly deps: Pick<HubServerDependencies, "now" | "options">) {}

  /** The roster changed (or may have): read it again on the next request. */
  invalidateRoster(): void {
    this.roster = undefined;
  }

  private async device(deviceId: string): Promise<HubDevice | undefined> {
    const read = () => {
      this.rosterReadAt = this.deps.now();
      return this.deps.options.storage.hub().devices().then((devices) => new Map(devices.map((device) => [device.deviceId, device])));
    };
    this.roster ??= read();
    try {
      const known = (await this.roster).get(deviceId);
      if (known) return known;
      // A device added by the setup (another process) is found on a fresh
      // read; an unknown one cannot make the hub read the roster more than
      // once a second.
      if (this.deps.now() - this.rosterReadAt < 1_000) return undefined;
      this.roster = read();
      return (await this.roster).get(deviceId);
    } catch (error) {
      this.roster = undefined;
      throw error;
    }
  }

  /** What can be checked before the body is read: a signature header from a
   *  device on the roster, with a fresh clock. Nobody else makes the hub
   *  read a body. */
  async preauthenticate(header: string | undefined): Promise<{ auth: ParsedHubAuthorization; device: HubDevice }> {
    const auth = parseHubAuthorization(header);
    if (!auth) throw new HubRequestError(401, "The request is not signed.");
    const device = await this.device(auth.deviceId);
    // Said apart: a phone taken off the roster asks to be paired again, one
    // whose clock is off does not.
    if (!device) throw new HubRequestError(401, HUB_NOT_ON_ROSTER);
    if (Math.abs(this.deps.now() - auth.timestampMs) > HUB_AUTH_MAX_SKEW_MS) throw new HubRequestError(401, "The request's clock is more than five minutes off.");
    return { auth, device };
  }

  async authenticate(method: string, body: Buffer, header: string | undefined, pathWithQuery: string, checked?: { auth: ParsedHubAuthorization; device: HubDevice }): Promise<HubDevice> {
    const { auth, device } = checked ?? await this.preauthenticate(header);
    const now = this.deps.now();
    if (!verifyHubRequest(auth, {
      method, pathWithQuery, body, publicKeyDerBase64: device.publicKeyDerBase64, now,
      seenNonce: (deviceId, nonce, timestampMs) => this.nonces.checkAndRemember(deviceId, nonce, timestampMs, now)
    })) {
      throw new HubRequestError(401, "The request's signature is not accepted.");
    }
    return device;
  }
}

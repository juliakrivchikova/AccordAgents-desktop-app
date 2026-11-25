import type { HubDevice } from "../shared/hubProtocol";
import type { HubAlertResult } from "../shared/urgentAlerts";
import type { HubAlertsOptions } from "./hubAlerts/types";
import { createHubAlertModules, type HubAlertModules } from "./hubAlerts/modules";

export type { HubAlertsOptions } from "./hubAlerts/types";
export { telegramText, callTwiml } from "./hubAlerts/alertText";

/**
 * Urgent alerts on the User's server (shared/urgentAlerts.ts). A member's
 * device raises one; from then on the server alone carries it: Telegram,
 * the wait, the calls, and the card in the chat, which it writes itself.
 * Every change runs one at a time, so Got it, a key press and a call
 * starting never interleave.
 */
export class HubAlerts {
  private readonly modules: HubAlertModules;

  constructor(options: HubAlertsOptions) {
    this.modules = createHubAlertModules({
      options,
      log: options.log ?? (() => undefined),
      now: options.now ?? (() => new Date()),
      fetchImpl: options.fetchImpl ?? fetch
    });
  }

  /** Picks up what was going on before a restart: waits, calls, Telegram. */
  start(): Promise<void> {
    return this.modules.alertFlow.start();
  }

  /** Stops timers and readers, and waits for the change under way (so the
   *  storage is not taken away under it). */
  close(): Promise<void> {
    return this.modules.alertFlow.close();
  }

  // --- requests from devices ----------------------------------------------------

  handle(device: HubDevice, raw: unknown): Promise<HubAlertResult<unknown>> {
    return this.modules.alertFlow.handle(device, raw);
  }

  /** A key pressed on an alert's call (POST from Twilio, signed by it). */
  twilioKey(url: URL, body: Buffer, signature: string | undefined): Promise<{ status: number; twiml: string }> {
    return this.modules.phoneCalls.twilioKey(url, body, signature);
  }
}

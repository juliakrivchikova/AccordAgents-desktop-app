import type { Client, Integration } from "@sentry/core";
import { scrubSerializedUsageLogs } from "../../shared/crashReportPrivacy";
import { moveTeamDeviceSessions } from "./teamDevice";

export interface OutgoingEnvelopeOptions {
  /** One of the team's own installations (teamDevice.ts). */
  teamDevice: boolean;
}

type EnvelopeItems = Array<[{ type?: string; item_count?: number } | undefined, unknown]>;

/**
 * The last look at everything on its way out. A team device's sessions move
 * to their own environment, and every log, whatever path it took (the
 * window's logs and scope attributes skip beforeSendLog), is checked again.
 */
export function prepareOutgoingEnvelope(items: EnvelopeItems, options: OutgoingEnvelopeOptions): void {
  if (options.teamDevice) moveTeamDeviceSessions(items);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const [header, payload] = items[index];
    if (header?.type !== "log") continue;
    const logItems = (payload as { items?: unknown[] } | undefined)?.items;
    const logs = Array.isArray(logItems) ? scrubSerializedUsageLogs(logItems) : [];
    if (logs.length === 0) {
      items.splice(index, 1);
    } else {
      (payload as { items: unknown[] }).items = logs;
      header.item_count = logs.length;
    }
  }
}

/**
 * Installs the last look before any integration is set up: the session
 * integration sends the launch's first session while the SDK is still
 * starting, before code after init could listen.
 */
export function outgoingEnvelopeIntegration(options: OutgoingEnvelopeOptions): Integration {
  return {
    name: "AccordAgentsOutgoingEnvelope",
    beforeSetup(client: Client) {
      client.on("beforeEnvelope", (envelope) => {
        prepareOutgoingEnvelope(envelope[1] as unknown as EnvelopeItems, options);
      });
    }
  };
}

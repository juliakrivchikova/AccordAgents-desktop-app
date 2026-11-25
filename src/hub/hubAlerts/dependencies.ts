import type { AlertFetch } from "../alertChannels";
import type { HubAlertsOptions } from "./types";

/** What alerts are given by the server. */
export interface HubAlertDependencies {
  readonly options: HubAlertsOptions;
  readonly log: (event: string, payload: Record<string, unknown>) => void;
  readonly now: () => Date;
  readonly fetchImpl: AlertFetch;
}

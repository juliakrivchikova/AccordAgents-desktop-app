import type { HubAlertDependencies } from "./dependencies";
import { AlertFlow } from "./alertFlow";
import { AlertRecords } from "./alertRecords";
import { AlertSettings } from "./alertSettings";
import { PhoneCalls } from "./phoneCalls";
import { PhoneTests } from "./phoneTests";
import { TelegramAlerts } from "./telegramAlerts";

/** The alerts' parts. Each names the ones it uses in its constructor. */
export interface HubAlertModules {
  readonly alertFlow: AlertFlow;
  readonly alertRecords: AlertRecords;
  readonly alertSettings: AlertSettings;
  readonly telegramAlerts: TelegramAlerts;
  readonly phoneCalls: PhoneCalls;
  readonly phoneTests: PhoneTests;
}

/** Builds every part around one registry: parts call each other only once all of them exist. */
export function createHubAlertModules(deps: HubAlertDependencies): HubAlertModules {
  const modules = {} as { -readonly [Key in keyof HubAlertModules]: HubAlertModules[Key] };
  modules.alertFlow = new AlertFlow(modules, deps);
  modules.alertRecords = new AlertRecords(modules, deps);
  modules.alertSettings = new AlertSettings(modules, deps);
  modules.telegramAlerts = new TelegramAlerts(modules, deps);
  modules.phoneCalls = new PhoneCalls(modules, deps);
  modules.phoneTests = new PhoneTests(modules, deps);
  return modules;
}

import { SettingsService } from "../../settings";
import type { SettingsDependencies } from "../dependencies";
import { createSettingsModules, type SettingsModules } from "../modules";

// The parts of the settings as their tests set them up and watch them: their
// private members too, so a test names the part that does the work.
type Open<T> = { -readonly [Key in keyof T]-?: any };

export function settingsParts(service: unknown): Open<SettingsModules> {
  return (service as { modules: Open<SettingsModules> }).modules;
}

/** What those settings were given; one object, shared by every part. */
export function settingsDependencies(service: unknown): Open<SettingsDependencies> {
  return settingsParts(service).settingsStore.deps as Open<SettingsDependencies>;
}

/** Settings that were given no file: a test says what is stored. */
export function settingsWithoutFile(): any {
  return Object.assign(Object.create(SettingsService.prototype), {
    modules: createSettingsModules({ options: {}, settingsPath: "" })
  });
}

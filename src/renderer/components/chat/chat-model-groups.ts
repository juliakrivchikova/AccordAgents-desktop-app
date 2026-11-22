import type { ProviderModel } from "../../../shared/types";
import { chipModelLabel } from "./chat-member-model-name";

/** A list this long is split, as Claude's desktop app splits its models
 *  (the newest of each family first, the rest under "More models"). */
const GROUP_FROM = 7;

/** A model's family: its name without versions or what is in brackets
 *  ("Opus 4.8" and "Opus 5.5" are both Opus; "GPT-5.6-Luna" and "GPT-6-Luna"
 *  both GPT Luna). */
export function modelFamily(model: ProviderModel): string {
  return chipModelLabel(model)
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\d+(?:[.-]\d+)*/g, " ")
    .replace(/[^a-z]+/g, " ")
    .trim();
}

/**
 * The models a menu lists first and those under "More models": in the CLI's
 * own order (newest first, as Claude Code's and Codex's lists come), the
 * first of each family, then the rest. A short list is not split. `shown`:
 * models already listed above it (the CLI's default), whose families count.
 */
export function latestAndOlderModels(models: readonly ProviderModel[], shown: readonly ProviderModel[] = []): { latest: ProviderModel[]; older: ProviderModel[] } {
  if (models.length + shown.length < GROUP_FROM) {
    return { latest: [...models], older: [] };
  }
  const seen = new Set<string>(shown.map(modelFamily).filter(Boolean));
  const latest: ProviderModel[] = [];
  const older: ProviderModel[] = [];
  for (const model of models) {
    const family = modelFamily(model);
    if (family && seen.has(family)) {
      older.push(model);
      continue;
    }
    seen.add(family);
    latest.push(model);
  }
  return { latest, older };
}

import type { RepoFileExternalOpenAction, RepoFileOpenAction } from "../../../../shared/types";
import type { StoredSettings } from "../types";

export function normalizeRepoFileOpenAction(action: unknown): RepoFileOpenAction | undefined {
  return action === "open" || action === "reveal" || action === "intellij-idea" || action === "panel" ? action : undefined;
}

export function normalizeRepoFileExternalOpenAction(action: unknown): RepoFileExternalOpenAction | undefined {
  return action === "open" || action === "intellij-idea" ? action : undefined;
}

/**
 * The file panel became the default click on 2026-10-30. The first read after
 * that moves the User's earlier choice to the panel's "Open in…" button and
 * makes the click open the panel, once: the flag is read back here, so a later
 * choice is never overwritten.
 */
export function mergeRepoFileOpenSettings(settings: StoredSettings): Pick<StoredSettings, "repoFileOpenAction" | "repoFileExternalOpenAction" | "repoFileOpenPanelMigrated"> {
  const action = normalizeRepoFileOpenAction(settings.repoFileOpenAction);
  const external = normalizeRepoFileExternalOpenAction(settings.repoFileExternalOpenAction);
  if (settings.repoFileOpenPanelMigrated === true) {
    return { repoFileOpenAction: action, repoFileExternalOpenAction: external, repoFileOpenPanelMigrated: true };
  }
  // Only an explicit earlier choice is carried over. Without one, a file the
  // panel does not show (an installer, an archive) still asks, as before.
  const carried = action === "intellij-idea" || action === "open" ? action : undefined;
  return { repoFileOpenAction: "panel", repoFileExternalOpenAction: carried ?? external, repoFileOpenPanelMigrated: true };
}

export function normalizeBetaUpdates(value: unknown): boolean {
  return value === true;
}

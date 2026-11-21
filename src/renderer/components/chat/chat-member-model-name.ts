import { useEffect, useState } from "react";

import { cliProviderHostDefaultModelLabel, cliProviderHostModelCatalog } from "../../../shared/cliProviderHosts";
import type { ChatParticipant, ProviderModel, ProviderModelCatalog } from "../../../shared/types";
import { chatCliProviderLabel } from "./chat-participant-drafts";

type ModelNamedMember = Pick<ChatParticipant, "kind" | "hostId" | "hostLabel" | "hostVendor">;

/** A model's name for a chip: its label without the id Codex repeats in
 *  brackets ("GPT-5.5 (gpt-5.5)" reads "GPT-5.5"). */
export function chipModelLabel(model: ProviderModel): string {
  const label = model.label.trim() || model.id;
  const repeated = ` (${model.id})`;
  return label.endsWith(repeated) && label.length > repeated.length ? label.slice(0, -repeated.length) : label;
}

/**
 * What a member without a model of its own runs on, as its model chip says
 * it: the vendor's default for a member on an added provider that has one,
 * else the model its CLI marks as its default (Claude Code's initialize
 * answer, Codex's model/list, `agy models`), else the CLI's own name ("Claude
 * Code"): never "Default model".
 */
export function memberDefaultModelName(member: ModelNamedMember, catalog: ProviderModelCatalog | undefined): string {
  const vendorDefault = member.hostVendor ? cliProviderHostDefaultModelLabel({ vendor: member.hostVendor }) : undefined;
  if (vendorDefault) return vendorDefault;
  // A model the app's own provider setting names is not what a member runs on.
  const used = catalog?.models.find((model) => model.recommended && model.source !== "configured" && !model.hidden);
  return used ? chipModelLabel(used) : chatCliProviderLabel(member.kind, member.hostLabel);
}

const CATALOG_REUSE_MS = 10 * 60_000;
const catalogs = new Map<string, { at: number; catalog: Promise<ProviderModelCatalog | undefined>; value?: ProviderModelCatalog }>();

function catalogKey(member: ModelNamedMember): { key: string; hostId?: string } {
  // Only Antigravity lists other models on a provider's key (use-provider-model-catalog).
  const hostId = member.hostVendor && member.kind === "gemini-cli" ? member.hostId : undefined;
  return { key: `${member.kind}\u0000${hostId ?? ""}`, hostId };
}

/** The CLI's model list, asked once in a while for every chip that shows
 *  it (the main process keeps it as well). */
function catalogFor(member: ModelNamedMember): Promise<ProviderModelCatalog | undefined> {
  const list = typeof window === "undefined" ? undefined : window.consensus?.listProviderModels;
  if (!list) return Promise.resolve(undefined);
  const { key, hostId } = catalogKey(member);
  const known = catalogs.get(key);
  if (known && Date.now() - known.at < CATALOG_REUSE_MS) return known.catalog;
  const entry: { at: number; catalog: Promise<ProviderModelCatalog | undefined>; value?: ProviderModelCatalog } = {
    at: Date.now(),
    catalog: Promise.resolve(undefined)
  };
  entry.catalog = list(member.kind, hostId).then((catalog) => {
    entry.value = catalog;
    return catalog;
  }, () => undefined);
  catalogs.set(key, entry);
  return entry.catalog;
}

/** memberDefaultModelName for a chip, once its CLI's list is known; the
 *  CLI's name meanwhile. Asks nothing while `enabled` is false. */
export function useMemberDefaultModelName(member: ModelNamedMember, enabled: boolean): string {
  const { key } = catalogKey(member);
  const [catalog, setCatalog] = useState<ProviderModelCatalog | undefined>(() => catalogs.get(key)?.value);
  useEffect(() => {
    if (!enabled || member.hostVendor && cliProviderHostDefaultModelLabel({ vendor: member.hostVendor })) return;
    let cancelled = false;
    void catalogFor(member).then((next) => {
      if (!cancelled) setCatalog(next);
    });
    return () => {
      cancelled = true;
    };
    // The list depends on the CLI and the provider only (its key).
  }, [enabled, key, member.hostVendor]);
  return memberDefaultModelName(member, catalog);
}

/** What a model chip names: the member's own model by its name in the list
 *  (T3 Code's "Opus 5.5", not the id), else memberDefaultModelName. */
export function memberModelName(member: ModelNamedMember & { model?: string }, catalog: ProviderModelCatalog | undefined): string {
  const explicit = member.model?.trim();
  if (!explicit) return memberDefaultModelName(member, catalog);
  const listed = catalog?.models.find((model) => model.id === explicit);
  return listed ? chipModelLabel(listed) : explicit;
}

/** memberModelName for a chip: an added provider's fixed list, else the
 *  CLI's list once known (the model's id or the CLI's name meanwhile). */
export function useMemberModelName(member: ModelNamedMember & { model?: string }): string {
  const fixed = member.hostVendor && member.kind !== "gemini-cli"
    ? cliProviderHostModelCatalog({ vendor: member.hostVendor, cli: member.kind })
    : undefined;
  const needsList = !fixed && !(member.hostVendor && !member.model?.trim() && cliProviderHostDefaultModelLabel({ vendor: member.hostVendor }));
  const { key } = catalogKey(member);
  const [catalog, setCatalog] = useState<ProviderModelCatalog | undefined>(() => catalogs.get(key)?.value);
  useEffect(() => {
    if (!needsList) return;
    let cancelled = false;
    void catalogFor(member).then((next) => {
      if (!cancelled) setCatalog(next);
    });
    return () => {
      cancelled = true;
    };
    // The list depends on the CLI and the provider only (its key).
  }, [needsList, key]);
  return memberModelName(member, fixed ?? catalog);
}

/** Forgets the lists asked so far (tests). */
export function resetMemberModelCatalogs(): void {
  catalogs.clear();
}

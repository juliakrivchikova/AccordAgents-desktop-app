import { Fragment, useEffect, useState } from "react";
import { KeyRound, Pencil, Plus, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { AgentHealth, CliProviderHost, CliProviderHostCli, CliProviderHostUpdate, CliProviderHostVendor } from "../../../shared/types";
import {
  CLI_PROVIDER_HOST_CLIS,
  cliProviderHostDefaultBaseUrl,
  cliProviderHostDefaultLabel,
  cliProviderHostValidationError,
  cliProviderHostVendorLabel,
  cliProviderHostVendorsFor
} from "../../../shared/cliProviderHosts";
import { deriveAgentReadiness } from "../../../shared/cliReadiness";
import { AppSelect, FormRow } from "../primitives";
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog";

const CLI_LABELS: Record<CliProviderHostCli, string> = { "claude-code": "Claude Code", "codex-cli": "Codex CLI" };

/** Added providers listed under the built-in CLIs in Local CLI setup, plus the
 *  Add / edit dialog. A provider is "ready" when its CLI runs and it has a key. */
export function ProviderHostRows(props: {
  hosts: CliProviderHost[];
  agents: AgentHealth[];
  onAdd: () => void;
  onEdit: (host: CliProviderHost) => void;
}): JSX.Element {
  return (
    <>
      {props.hosts.map((host) => (
        <Fragment key={host.id}>
          <div className="gen-card-divider" />
          <div className="gen-cli-row gen-host-row" data-provider-host-id={host.id}>
            <span className="gen-cli-icon gen-host-icon" aria-hidden>
              <KeyRound size={18} />
            </span>
            <div className="gen-cli-text">
              <div className="gen-cli-name">{host.label}</div>
              <div className="gen-cli-sub">{hostStatusLine(host, props.agents)}</div>
            </div>
            <button
              type="button"
              className="gen-host-edit"
              aria-label={`Edit ${host.label}`}
              data-testid={`provider-host-edit-${host.id}`}
              onClick={() => props.onEdit(host)}
            >
              <Pencil size={15} aria-hidden />
            </button>
          </div>
        </Fragment>
      ))}
      <div className="gen-card-divider" />
      <div className="gen-host-add-row">
        <Button type="button" variant="outline" size="sm" data-testid="provider-host-add" onClick={props.onAdd}>
          <Plus size={14} aria-hidden />
          Add provider
        </Button>
        <span className="gen-host-add-hint">Reach another vendor's models through Claude Code or Codex with your own API key.</span>
      </div>
    </>
  );
}

function hostStatusLine(host: CliProviderHost, agents: AgentHealth[]): string {
  const cliReadiness = deriveAgentReadiness(agents.find((agent) => agent.kind === host.cli));
  const via = `via ${CLI_LABELS[host.cli]}`;
  if (cliReadiness === "not-detected") {
    return `${CLI_LABELS[host.cli]} not detected · ${via}`;
  }
  if (cliReadiness === "failed-to-run") {
    return `${CLI_LABELS[host.cli]} failed to run · ${via}`;
  }
  if (!host.hasApiKey) {
    return `API key missing · ${via}`;
  }
  return `Ready · ${cliProviderHostVendorLabel(host.vendor)} · ${via}`;
}

export interface ProviderHostEditorState {
  type: "create" | "edit";
  host?: CliProviderHost;
}

interface HostDraft {
  cli: CliProviderHostCli;
  vendor: CliProviderHostVendor;
  label: string;
  baseUrl: string;
  /** undefined = keep the stored key (edit); string = replace / set. */
  apiKey: string | undefined;
}

function initialHostDraft(state: ProviderHostEditorState | undefined): HostDraft {
  if (state?.host) {
    return { cli: state.host.cli, vendor: state.host.vendor, label: state.host.label, baseUrl: state.host.baseUrl, apiKey: undefined };
  }
  const cli: CliProviderHostCli = "claude-code";
  const vendor: CliProviderHostVendor = "zai";
  return {
    cli,
    vendor,
    label: cliProviderHostDefaultLabel(vendor, cli),
    baseUrl: cliProviderHostDefaultBaseUrl(vendor, cli),
    apiKey: ""
  };
}

export function ProviderHostEditorDialog(props: {
  editor?: ProviderHostEditorState;
  hosts: CliProviderHost[];
  onSave: (update: CliProviderHostUpdate) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const open = Boolean(props.editor);
  const host = props.editor?.host;
  const [draft, setDraft] = useState<HostDraft>(() => initialHostDraft(props.editor));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Validation is shown once the user has tried to save, not on a fresh form.
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(initialHostDraft(props.editor));
      setSaving(false);
      setDeleting(false);
      setDeleteConfirmOpen(false);
      setError(undefined);
      setAttempted(false);
    }
  }, [open, props.editor]);

  const vendors = cliProviderHostVendorsFor(draft.cli);
  const isDefaultName = (label: string, vendor: CliProviderHostVendor, cli: CliProviderHostCli): boolean =>
    label.trim() === "" || label.trim() === cliProviderHostDefaultLabel(vendor, cli);
  const isDefaultUrl = (url: string, vendor: CliProviderHostVendor, cli: CliProviderHostCli): boolean =>
    url.trim() === "" || url.trim() === cliProviderHostDefaultBaseUrl(vendor, cli);

  // Switching vendor or CLI re-seeds name and URL unless the user typed their own.
  function selectCli(cli: CliProviderHostCli): void {
    setDraft((current) => {
      const vendor = cliProviderHostVendorsFor(cli).includes(current.vendor) ? current.vendor : cliProviderHostVendorsFor(cli)[0];
      return {
        ...current,
        cli,
        vendor,
        label: isDefaultName(current.label, current.vendor, current.cli) ? cliProviderHostDefaultLabel(vendor, cli) : current.label,
        baseUrl: isDefaultUrl(current.baseUrl, current.vendor, current.cli) ? cliProviderHostDefaultBaseUrl(vendor, cli) : current.baseUrl
      };
    });
  }

  function selectVendor(vendor: CliProviderHostVendor): void {
    setDraft((current) => ({
      ...current,
      vendor,
      label: isDefaultName(current.label, current.vendor, current.cli) ? cliProviderHostDefaultLabel(vendor, current.cli) : current.label,
      baseUrl: isDefaultUrl(current.baseUrl, current.vendor, current.cli) ? cliProviderHostDefaultBaseUrl(vendor, current.cli) : current.baseUrl
    }));
  }

  const validation = cliProviderHostValidationError(draft)
    ?? (!host && !draft.apiKey?.trim() ? "Paste the provider's API key." : undefined)
    ?? (props.hosts.some((item) => item.id !== host?.id && item.label.trim().toLowerCase() === draft.label.trim().toLowerCase())
      ? `A provider named "${draft.label.trim()}" already exists.`
      : undefined);
  const canSave = !saving;

  async function save(): Promise<void> {
    setAttempted(true);
    if (validation || saving) {
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await props.onSave({
        id: host?.id,
        cli: draft.cli,
        vendor: draft.vendor,
        label: draft.label.trim(),
        baseUrl: draft.baseUrl.trim(),
        ...(draft.apiKey !== undefined ? { apiKey: draft.apiKey } : {})
      });
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function deleteHost(): Promise<void> {
    if (!host || deleting) {
      return;
    }
    setDeleting(true);
    try {
      await props.onDelete(host.id);
      props.onClose();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          props.onClose();
        }
      }}>
        <DialogContent className="participants-editor-dialog provider-host-dialog" showCloseButton={false}>
          <DialogHeader className="participants-editor-head">
            <div className="participants-editor-profile">
              <span className="participants-editor-title-block">
                <DialogTitle>{host ? host.label : "Add provider"}</DialogTitle>
                <DialogDescription>
                  {host ? "Saved provider" : "A vendor endpoint reached through a local CLI with your own API key."}
                </DialogDescription>
              </span>
              <DialogClose asChild>
                <button type="button" className="participants-editor-close" aria-label="Close provider editor">
                  <X size={15} aria-hidden />
                </button>
              </DialogClose>
            </div>
          </DialogHeader>
          <div className="participants-editor-body provider-host-form">
            <FormRow label="Runs through">
              <AppSelect
                value={draft.cli}
                placeholder="Select CLI"
                ariaLabel="Provider CLI"
                options={CLI_PROVIDER_HOST_CLIS.map((cli) => ({ value: cli, label: CLI_LABELS[cli] }))}
                onValueChange={(value) => selectCli(value as CliProviderHostCli)}
              />
            </FormRow>
            <FormRow label="Vendor">
              <AppSelect
                value={draft.vendor}
                placeholder="Select vendor"
                ariaLabel="Provider vendor"
                options={vendors.map((vendor) => ({ value: vendor, label: cliProviderHostVendorLabel(vendor) }))}
                onValueChange={(value) => selectVendor(value as CliProviderHostVendor)}
              />
            </FormRow>
            <FormRow label="Name">
              <Input
                value={draft.label}
                aria-label="Provider name"
                placeholder={cliProviderHostDefaultLabel(draft.vendor, draft.cli)}
                onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
              />
            </FormRow>
            <FormRow label="Endpoint URL" hint={draft.vendor === "custom" ? (draft.cli === "codex-cli" ? "Must speak the OpenAI Responses API." : "Must speak the Anthropic Messages API.") : undefined}>
              <Input
                value={draft.baseUrl}
                aria-label="Provider endpoint URL"
                placeholder={cliProviderHostDefaultBaseUrl(draft.vendor, draft.cli) || "https://"}
                spellCheck={false}
                onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))}
              />
            </FormRow>
            <FormRow label="API key" hint={host?.hasApiKey && draft.apiKey === undefined ? "A key is stored. Paste a new one to replace it." : "Stored encrypted on this Mac; never shown again."}>
              <Input
                type="password"
                value={draft.apiKey ?? ""}
                aria-label="Provider API key"
                placeholder={host?.hasApiKey ? "••••••••" : "Paste the key"}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))}
              />
            </FormRow>
            {(error ?? (attempted ? validation : undefined)) && (
              <div className="inline-error participants-editor-error">{error ?? validation}</div>
            )}
          </div>
          <DialogFooter className="participants-editor-footer">
            {host && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="participants-editor-delete"
                disabled={saving || deleting}
                title="Remove this provider. Members bound to it stop running until they are bound to another provider."
                data-testid="provider-host-delete"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                <Trash2 size={14} aria-hidden />
                Remove provider
              </Button>
            )}
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm" disabled={saving}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" size="sm" disabled={!canSave} data-testid="provider-host-save" onClick={() => void save()}>
              {saving ? "Saving..." : host ? "Save" : "Add provider"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {host && (
        <DeleteConfirmationDialog
          open={deleteConfirmOpen}
          title={`Remove ${host.label}?`}
          description="Members bound to this provider stop running until you bind them to another provider. The stored API key is deleted."
          confirmLabel="Remove"
          pending={deleting}
          onOpenChange={setDeleteConfirmOpen}
          onConfirm={deleteHost}
        />
      )}
    </>
  );
}

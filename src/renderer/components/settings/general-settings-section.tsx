import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Code2, ExternalLink, FolderOpen, HelpCircle, Server } from "lucide-react";

import type { AgentHealth, CloudRunsSettings, CloudRunsSettingsUpdate, ProviderKind, ProviderSettings, RepoFileOpenAction } from "../../../shared/types";
import { CLI_AGENT_RUN_TIMEOUT_MAX_MS, CLI_AGENT_RUN_TIMEOUT_MIN_MS, cliAgentRunTimeoutHours } from "../../../shared/cliAgentRunSettings";

const CLI_ICON_URLS: Partial<Record<ProviderKind, string>> = {
  "codex-cli": new URL("../../assets/codex-cli.svg", import.meta.url).href,
  "claude-code": new URL("../../assets/claude-avatar.png", import.meta.url).href
};

export function GeneralSettingsSection(props: {
  providers: ProviderSettings[];
  agents: AgentHealth[];
  repoFileOpenAction?: RepoFileOpenAction;
  cliAgentRunTimeoutMs: number;
  cloudRuns: CloudRunsSettings;
  updateProvider: (provider: ProviderSettings, patch: { enabled?: boolean }) => Promise<void>;
  setRepoFileOpenPreference: (action: RepoFileOpenAction | null) => Promise<void>;
  setCliAgentRunTimeoutMs: (timeoutMs: number) => Promise<void>;
  saveCloudRunsSettings: (update: CloudRunsSettingsUpdate) => Promise<void>;
}): JSX.Element {
  const detectedCount = props.providers.filter(
    (provider) => props.agents.find((agent) => agent.kind === provider.kind)?.installed
  ).length;
  return (
    <>
      <section className="gen-section">
        <div className="gen-section-head">
          <h2 className="gen-section-title">Local CLI setup</h2>
          <span className="gen-section-meta">{detectedCount} of {props.providers.length} detected</span>
        </div>
        <div className="gen-card">
          {props.providers.map((provider, index) => {
            const health = props.agents.find((agent) => agent.kind === provider.kind);
            const iconUrl = CLI_ICON_URLS[provider.kind];
            return (
              <Fragment key={provider.kind}>
                {index > 0 && <div className="gen-card-divider" />}
                <div className="gen-cli-row">
                  <span className={`gen-cli-icon${provider.kind === "claude-code" ? " gen-cli-icon-full" : ""}`}>
                    {iconUrl ? <img src={iconUrl} alt="" /> : null}
                  </span>
                  <div className="gen-cli-text">
                    <div className="gen-cli-name">{provider.label}</div>
                    <div className="gen-cli-sub">{healthLine(health)}</div>
                  </div>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={provider.enabled}
                      onChange={(event) => void props.updateProvider(provider, { enabled: event.target.checked })}
                    />
                    <span />
                  </label>
                </div>
              </Fragment>
            );
          })}
        </div>
      </section>

      <section className="gen-section">
        <div className="gen-section-head">
          <h2 className="gen-section-title">Cloud Runs</h2>
          <span className="gen-section-meta">{props.cloudRuns.enabled ? "Enabled" : "Disabled"}</span>
        </div>
        <CloudRunsControl settings={props.cloudRuns} onSave={props.saveCloudRunsSettings} />
      </section>

      <section className="gen-section">
        <h2 className="gen-section-title gen-section-title-solo">General</h2>
        <div className="gen-card">
          <div className="gen-row">
            <div className="gen-row-text">
              <div className="gen-row-title">Default file open destination</div>
              <div className="gen-row-desc">
                What happens when you click an inside-workspace file reference in chat.
              </div>
            </div>
            <FileOpenDropdown action={props.repoFileOpenAction} onChange={props.setRepoFileOpenPreference} />
          </div>
          <div className="gen-card-divider" />
          <div className="gen-row">
            <div className="gen-row-text">
              <div className="gen-row-title">Run timeout</div>
              <div className="gen-row-desc">Automatically stop an agent run after this many hours.</div>
            </div>
            <CliAgentRunTimeoutControl timeoutMs={props.cliAgentRunTimeoutMs} onChange={props.setCliAgentRunTimeoutMs} />
          </div>
        </div>
      </section>
    </>
  );
}

function CloudRunsControl(props: {
  settings: CloudRunsSettings;
  onSave: (update: CloudRunsSettingsUpdate) => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState<CloudRunsSettings>(props.settings);
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(props.settings);
  }, [props.settings]);

  const patch = (update: CloudRunsSettingsUpdate): void => {
    setDraft((current) => ({
      ...current,
      ...update,
      worker: {
        ...current.worker,
        ...(update.worker ?? {})
      }
    }));
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setStatus("");
    try {
      await props.onSave(draft);
      setStatus("Saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const test = async (): Promise<void> => {
    setBusy(true);
    setStatus("Testing worker...");
    try {
      const result = await window.consensus.testCloudRunWorker(draft.worker);
      setStatus(result.message);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gen-card">
      <div className="gen-row">
        <div className="gen-row-text">
          <div className="gen-row-title">Remote Codex worker</div>
          <div className="gen-row-desc">Use one pre-provisioned SSH worker for Codex participants marked remote.</div>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => patch({ enabled: event.target.checked })}
          />
          <span />
        </label>
      </div>
      <div className="gen-card-divider" />
      <div className="gen-row gen-row-stack">
        <div className="gen-row-text">
          <div className="gen-row-title">SSH target</div>
          <div className="gen-row-desc">Host is required; other fields inherit ssh defaults when empty.</div>
        </div>
        <div className="gen-grid-form">
          <input className="gen-input" placeholder="Host" value={draft.worker.host ?? ""} onChange={(event) => patch({ worker: { host: event.target.value } })} />
          <input className="gen-input" placeholder="User" value={draft.worker.user ?? ""} onChange={(event) => patch({ worker: { user: event.target.value } })} />
          <input
            className="gen-input"
            placeholder="Port"
            inputMode="numeric"
            value={draft.worker.port ?? ""}
            onChange={(event) => patch({ worker: { port: event.target.value ? Number(event.target.value) : undefined } })}
          />
          <input className="gen-input" placeholder="Identity file" value={draft.worker.identityFile ?? ""} onChange={(event) => patch({ worker: { identityFile: event.target.value } })} />
          <input className="gen-input" placeholder="Worker root" value={draft.worker.workerRoot ?? ""} onChange={(event) => patch({ worker: { workerRoot: event.target.value } })} />
          <input className="gen-input" placeholder="Remote repo/cwd" value={draft.worker.remoteCwd ?? ""} onChange={(event) => patch({ worker: { remoteCwd: event.target.value } })} />
          <input className="gen-input" placeholder="Codex path" value={draft.worker.codexPath ?? ""} onChange={(event) => patch({ worker: { codexPath: event.target.value } })} />
        </div>
      </div>
      <div className="gen-card-divider" />
      <div className="gen-row gen-row-stack">
        <div className="gen-row-text">
          <div className="gen-row-title">Runtime</div>
          <div className="gen-row-desc">Detached worker timeout and desktop reconnect polling.</div>
        </div>
        <div className="gen-grid-form gen-grid-form-compact">
          <input
            className="gen-input"
            aria-label="Maximum runtime minutes"
            inputMode="numeric"
            value={Math.round(draft.maxRuntimeMs / 60_000)}
            onChange={(event) => patch({ maxRuntimeMs: Math.max(1, Number(event.target.value) || 1) * 60_000 })}
          />
          <input
            className="gen-input"
            aria-label="Poll interval milliseconds"
            inputMode="numeric"
            value={draft.pollIntervalMs}
            onChange={(event) => patch({ pollIntervalMs: Math.max(500, Number(event.target.value) || 500) })}
          />
        </div>
      </div>
      <div className="gen-card-divider" />
      <div className="gen-row">
        <div className="gen-row-text">
          <div className="gen-row-title">{status || "Ready"}</div>
        </div>
        <div className="gen-actions">
          <button type="button" className="gen-pill" disabled={busy} onClick={() => void test()}>
            <span className="gen-pill-lead"><Server size={16} /></span>
            <span className="gen-pill-label">Test</span>
          </button>
          <button type="button" className="gen-pill" disabled={busy} onClick={() => void save()}>
            <span className="gen-pill-label">Save</span>
          </button>
        </div>
      </div>
    </div>
  );
}

const FILE_OPEN_OPTIONS: Array<{
  key: "open" | "reveal" | "intellij-idea" | "ask";
  value: RepoFileOpenAction | null;
  pillLabel: string;
  menuLabel: string;
  icon: typeof ExternalLink;
}> = [
  { key: "open", value: "open", pillLabel: "Open with default app", menuLabel: "Open with default app", icon: ExternalLink },
  { key: "reveal", value: "reveal", pillLabel: "Reveal in file manager", menuLabel: "Reveal in file manager", icon: FolderOpen },
  { key: "intellij-idea", value: "intellij-idea", pillLabel: "Open in IntelliJ IDEA", menuLabel: "Open in IntelliJ IDEA", icon: Code2 },
  { key: "ask", value: null, pillLabel: "Ask every time", menuLabel: "Reset to ask", icon: HelpCircle }
];

function FileOpenDropdown(props: {
  action?: RepoFileOpenAction;
  onChange: (action: RepoFileOpenAction | null) => Promise<void>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const currentKey = props.action === "open"
    ? "open"
    : props.action === "reveal"
      ? "reveal"
      : props.action === "intellij-idea"
        ? "intellij-idea"
        : "ask";
  const current = FILE_OPEN_OPTIONS.find((option) => option.key === currentKey)
    ?? FILE_OPEN_OPTIONS.find((option) => option.key === "ask")
    ?? FILE_OPEN_OPTIONS[0];

  const closeMenu = (returnFocus: boolean): void => {
    setOpen(false);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  };

  const openMenu = (): void => {
    // Anchor to the trigger's viewport rect and render in a portal so the
    // settings pane's overflow:auto can't clip the menu near the pane edge.
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setMenuPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    }
    setOpen(true);
  };

  const menuItems = (): HTMLButtonElement[] =>
    menuRef.current ? Array.from(menuRef.current.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]")) : [];

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      closeMenu(false);
    };
    const dismiss = (): void => closeMenu(false);
    const onKeyDown = (event: KeyboardEvent): void => {
      const items = menuItems();
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu(true);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!items.length) {
          return;
        }
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const delta = event.key === "ArrowDown" ? 1 : -1;
        items[(index + delta + items.length) % items.length]?.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        items[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        items[items.length - 1]?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    // A fixed menu would drift on scroll/resize; dismiss instead of repositioning.
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    const focusFrame = requestAnimationFrame(() => {
      const items = menuItems();
      const selected = items.find((item) => item.getAttribute("aria-checked") === "true");
      (selected ?? items[0])?.focus();
    });
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      cancelAnimationFrame(focusFrame);
    };
  }, [open]);

  const select = (value: RepoFileOpenAction | null): void => {
    closeMenu(true);
    void props.onChange(value);
  };

  const CurrentIcon = current.icon;
  return (
    <div className="gen-dropdown">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`gen-pill ${open ? "is-open" : ""}`}
        onClick={() => (open ? closeMenu(true) : openMenu())}
      >
        <span className="gen-pill-lead"><CurrentIcon size={16} /></span>
        <span className="gen-pill-label">{current.pillLabel}</span>
        <ChevronDown size={16} className="gen-pill-chev" />
      </button>
      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          className="gen-menu"
          role="menu"
          style={{ position: "fixed", top: menuPos.top, right: menuPos.right }}
        >
          {FILE_OPEN_OPTIONS.map((option) => {
            const Icon = option.icon;
            const selected = option.key === current.key;
            return (
              <button
                type="button"
                key={option.key}
                role="menuitemradio"
                aria-checked={selected}
                className={`gen-menu-item ${selected ? "is-selected" : ""}`}
                onClick={() => select(option.value)}
              >
                <span className="gen-menu-item-icon"><Icon size={16} /></span>
                <span className="gen-menu-item-label">{option.menuLabel}</span>
                {selected && <Check size={15} className="gen-menu-item-check" />}
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}

function CliAgentRunTimeoutControl(props: {
  timeoutMs: number;
  onChange: (timeoutMs: number) => Promise<void>;
}): JSX.Element {
  const currentHours = cliAgentRunTimeoutHours(props.timeoutMs);
  const [hours, setHours] = useState(String(currentHours));
  const minHours = CLI_AGENT_RUN_TIMEOUT_MIN_MS / (60 * 60_000);
  const maxHours = CLI_AGENT_RUN_TIMEOUT_MAX_MS / (60 * 60_000);
  const trimmed = hours.trim();
  const parsed = Number(trimmed);
  const validation = trimmed === ""
    ? undefined
    : !Number.isFinite(parsed) || !Number.isInteger(parsed)
      ? "Use a whole number of hours."
      : parsed < minHours || parsed > maxHours
        ? `Use ${minHours} to ${maxHours} hours.`
        : undefined;
  const timeoutMs = parsed * 60 * 60_000;
  const canSave = trimmed !== "" && !validation && timeoutMs !== props.timeoutMs;

  useEffect(() => {
    setHours(String(currentHours));
  }, [currentHours]);

  return (
    <div className="gen-row-control">
      <div className="gen-timeout">
        <div className="gen-timeout-field">
          <input
            className="gen-timeout-input"
            inputMode="numeric"
            value={hours}
            aria-label="Run timeout in hours"
            onChange={(event) => setHours(event.target.value)}
          />
          <span className="gen-timeout-unit">Hours</span>
        </div>
        <button
          type="button"
          className={`gen-timeout-save ${canSave ? "is-dirty" : ""}`}
          disabled={!canSave}
          onClick={() => void props.onChange(timeoutMs)}
        >
          Save
        </button>
      </div>
      {validation && <div className="gen-timeout-error">{validation}</div>}
    </div>
  );
}

function healthLine(health: AgentHealth | undefined): string {
  if (!health) {
    return "Not checked";
  }
  if (!health.installed) {
    return "Not installed";
  }
  const base = health.version || health.path || "Installed";
  const syncIssue = appSkillSyncIssueLine(health.appSkillSync);
  return syncIssue ? `${base} · ${syncIssue}` : base;
}

function appSkillSyncIssueLine(sync: AgentHealth["appSkillSync"]): string | undefined {
  if (!sync || sync.status === "not-installed" || sync.status === "synced" || sync.status === "skipped") {
    return undefined;
  }
  if (sync.status === "collision") {
    return sync.message ?? "App skill collision";
  }
  return sync.message ?? "App skill sync failed";
}

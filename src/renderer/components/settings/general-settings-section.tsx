import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, CheckCircle2, ChevronDown, Code2, Copy, ExternalLink, FolderOpen, HelpCircle, Server } from "lucide-react";

import type {
  AgentHealth,
  CloudRunsSettings,
  CloudRunsSettingsUpdate,
  CloudRunWorkerDoctorReport,
  CloudRunWorkerMode,
  CloudRunWorkerSetupProgress,
  ChatPromptContextMode,
  ChatPromptContextScopeSettings,
  ChatPromptContextSettings,
  ProviderKind,
  ProviderSettings,
  RepoFileOpenAction
} from "../../../shared/types";
import {
  CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_MAX,
  CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_MIN,
  CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_MAX,
  CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_MIN
} from "../../../shared/chatParticipantRequests";
import {
  CHAT_AUTO_WATCH_WAKE_LIMIT_MAX,
  CHAT_AUTO_WATCH_WAKE_LIMIT_MIN
} from "../../../shared/chatAutoWatch";
import { CLI_AGENT_RUN_TIMEOUT_MAX_MS, CLI_AGENT_RUN_TIMEOUT_MIN_MS, cliAgentRunTimeoutHours } from "../../../shared/cliAgentRunSettings";
import {
  CHAT_PROMPT_CONTEXT_LIMIT_MAX,
  normalizeChatPromptContextSettings
} from "../../../shared/chatPromptContext";
import { writeClipboardText, type ClipboardWriteResult } from "../../../shared/clipboard";
import { AwsWorkerPanel as SharedAwsWorkerPanel } from "./aws-worker-panel";

const PARTICIPANT_REQUEST_DEPTH_HELP = "Limits transitive member-to-member request nesting, not repeated rounds by the same requester.";
const PARTICIPANT_REQUEST_PROMPT_MAX_HELP = "Maximum characters accepted for each member request prompt. Longer prompts are rejected, not truncated.";
const AUTO_WATCH_WAKE_LIMIT_HELP = "Pauses auto-watch after this many automatic watcher runs happen without a user message.";
type ClipboardFeedback = "idle" | ClipboardWriteResult;

const CLI_ICON_URLS: Partial<Record<ProviderKind, string>> = {
  "codex-cli": new URL("../../assets/codex-cli.svg", import.meta.url).href,
  "claude-code": new URL("../../assets/claude-avatar.png", import.meta.url).href
};

export function GeneralSettingsSection(props: {
  providers: ProviderSettings[];
  agents: AgentHealth[];
  repoFileOpenAction?: RepoFileOpenAction;
  cliAgentRunTimeoutMs: number;
  chatParticipantRequestMaxDepth: number;
  chatParticipantRequestPromptMaxChars: number;
  chatAutoWatchWakeLimit: number;
  chatPromptContext: ChatPromptContextSettings;
  cloudRuns: CloudRunsSettings;
  updateProvider: (provider: ProviderSettings, patch: { enabled?: boolean }) => Promise<void>;
  setRepoFileOpenPreference: (action: RepoFileOpenAction | null) => Promise<void>;
  setCliAgentRunTimeoutMs: (timeoutMs: number) => Promise<void>;
  setChatParticipantRequestMaxDepth: (maxDepth: number) => Promise<void>;
  setChatParticipantRequestPromptMaxChars: (maxChars: number) => Promise<void>;
  setChatAutoWatchWakeLimit: (limit: number) => Promise<void>;
  setChatPromptContext: (settings: ChatPromptContextSettings) => Promise<void>;
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
          <div className="gen-card-divider" />
          <div className="gen-row">
            <div className="gen-row-text">
              <div className="gen-row-title">Prompt context</div>
              <div className="gen-row-desc">
                Automatically include unseen chat messages when an agent starts. Set Thread and Timeline to Off or 0 to send only the message that started the run.
              </div>
            </div>
            <PromptContextControl settings={props.chatPromptContext} onChange={props.setChatPromptContext} />
          </div>
          <div className="gen-card-divider" />
          <div className="gen-row">
            <div className="gen-row-text">
              <div className="gen-row-title" title={AUTO_WATCH_WAKE_LIMIT_HELP}>Auto-watch run limit</div>
              <div className="gen-row-desc">
                {AUTO_WATCH_WAKE_LIMIT_HELP}
              </div>
            </div>
            <AutoWatchWakeLimitControl
              limit={props.chatAutoWatchWakeLimit}
              onChange={props.setChatAutoWatchWakeLimit}
            />
          </div>
          <div className="gen-card-divider" />
          <div className="gen-row">
            <div className="gen-row-text">
              <div className="gen-row-title" title={PARTICIPANT_REQUEST_DEPTH_HELP}>Member request depth</div>
              <div className="gen-row-desc">
                {PARTICIPANT_REQUEST_DEPTH_HELP} Use 1 to prevent requested members from asking others.
              </div>
            </div>
            <ParticipantRequestDepthControl
              maxDepth={props.chatParticipantRequestMaxDepth}
              onChange={props.setChatParticipantRequestMaxDepth}
            />
          </div>
          <div className="gen-card-divider" />
          <div className="gen-row">
            <div className="gen-row-text">
              <div className="gen-row-title" title={PARTICIPANT_REQUEST_PROMPT_MAX_HELP}>Member request prompt limit</div>
              <div className="gen-row-desc">
                {PARTICIPANT_REQUEST_PROMPT_MAX_HELP}
              </div>
            </div>
            <ParticipantRequestPromptMaxControl
              maxChars={props.chatParticipantRequestPromptMaxChars}
              onChange={props.setChatParticipantRequestPromptMaxChars}
            />
          </div>
        </div>
      </section>

      <section className="gen-section">
        <h2 className="gen-section-title gen-section-title-solo">Cloud Runs (beta)</h2>
        <CloudRunsControl settings={props.cloudRuns} onSave={props.saveCloudRunsSettings} />
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
  const [report, setReport] = useState<CloudRunWorkerDoctorReport | null>(null);
  const [setupProgress, setSetupProgress] = useState<CloudRunWorkerSetupProgress | null>(null);
  const [authCopyFeedback, setAuthCopyFeedback] = useState<ClipboardFeedback>("idle");

  useEffect(() => {
    setDraft(props.settings);
  }, [props.settings]);

  useEffect(() => window.consensus.onCloudRunSetupProgress(setSetupProgress), []);

  useEffect(() => {
    setAuthCopyFeedback("idle");
  }, [setupProgress?.authCode]);

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

  const savePatch = async (update: CloudRunsSettingsUpdate, successMessage?: string): Promise<void> => {
    patch(update);
    setBusy(true);
    setStatus("");
    try {
      await props.onSave(update);
      setStatus(successMessage ?? "Saved.");
    } catch (error) {
      setDraft(props.settings);
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const diagnose = async (): Promise<void> => {
    setBusy(true);
    setStatus("Checking worker...");
    setReport(null);
    try {
      const result = await window.consensus.diagnoseCloudRunWorker(draft.mode === "aws" ? undefined : draft.worker);
      setReport(result);
      setStatus(result.message);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const setup = async (): Promise<void> => {
    setBusy(true);
    setStatus("Setting up worker...");
    setSetupProgress(null);
    try {
      const result = await window.consensus.setupCloudRunWorker(draft.mode === "aws" ? undefined : draft.worker);
      setReport(result);
      setStatus(result.message);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      setSetupProgress(null);
    }
  };

  const setMode = (mode: CloudRunWorkerMode): void => {
    void savePatch({ mode });
  };

  const copyAuthCode = async (): Promise<void> => {
    const authCode = setupProgress?.authCode;
    if (!authCode) {
      return;
    }
    const result = await writeClipboardText(authCode, (value) => navigator.clipboard.writeText(value));
    setAuthCopyFeedback(result);
    window.setTimeout(() => setAuthCopyFeedback("idle"), 1400);
  };

  const authCopyLabel = authCopyFeedback === "copied"
    ? "Copied"
    : authCopyFeedback === "failed"
      ? "Copy failed"
      : "Copy";
  const authCopyAriaLabel = authCopyFeedback === "copied"
    ? "Copied device authentication code"
    : authCopyFeedback === "failed"
      ? "Copy device authentication code failed"
      : "Copy device authentication code";

  return (
    <div className="gen-card">
      <div className="gen-row">
        <div className="gen-row-text">
          <div className="gen-row-title">Remote Codex worker</div>
          <div className="gen-row-desc">Run Codex members marked remote on a worker instead of this machine.</div>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            data-testid="remote-codex-worker-toggle"
            checked={draft.enabled}
            disabled={busy}
            onChange={(event) => {
              const enabled = event.target.checked;
              void savePatch({ enabled });
            }}
          />
          <span />
        </label>
      </div>
      <fieldset
        className="gen-cloud-runs-settings"
        data-testid="remote-codex-worker-settings"
        disabled={!draft.enabled}
      >
        <div className="gen-card-divider" />
        <div className="gen-row">
        <div className="gen-row-text">
          <div className="gen-row-title">Worker source</div>
          <div className="gen-row-desc">Let the app create and manage an EC2 worker, or point it at a box you own.</div>
        </div>
        <div className="gen-segmented" role="tablist" aria-label="Worker source">
          <button
            type="button"
            role="tab"
            aria-selected={draft.mode === "aws"}
            className={`gen-segment ${draft.mode === "aws" ? "is-active" : ""}`}
            onClick={() => setMode("aws")}
          >
            App-managed (AWS)
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={draft.mode !== "aws"}
            className={`gen-segment ${draft.mode !== "aws" ? "is-active" : ""}`}
            onClick={() => setMode("ssh")}
          >
            My own box (SSH)
          </button>
        </div>
      </div>
      <div className="gen-card-divider" />
      {draft.mode === "aws" ? (
        <SharedAwsWorkerPanel
          settings={draft}
          onInstanceTypeChange={(value) => patch({ awsInstanceType: value })}
          onDiskSizeChange={(value) => patch({ awsRootVolumeSizeGb: value })}
          onDeleted={() => props.onSave({ mode: "ssh" })}
        />
      ) : null}
      <div className={draft.mode === "aws" ? "gen-collapsed" : ""} hidden={draft.mode === "aws"}>
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
      </div>
      {draft.mode !== "aws" ? <><div className="gen-card-divider" />
      <div className="gen-row">
        <div className="gen-row-text">
          <div className="gen-row-title">{(busy && setupProgress?.message) || status || "Ready"}</div>
          {busy && setupProgress?.authUrl && (
            <div className="gen-row-desc">
              <button
                type="button"
                className="gen-doctor-auth-link"
                onClick={() => void window.consensus.openExternal(setupProgress.authUrl as string)}
              >
                Open the sign-in page
              </button>
              {setupProgress.authCode ? (
                <>
                  {" and enter code "}
                  <code className="gen-doctor-auth-code" data-testid="cloud-run-device-auth-code">
                    {setupProgress.authCode}
                  </code>
                  <button
                    type="button"
                    className="gen-doctor-auth-copy"
                    data-testid="cloud-run-device-auth-copy"
                    aria-label={authCopyAriaLabel}
                    onClick={() => void copyAuthCode()}
                  >
                    {authCopyFeedback === "copied"
                      ? <CheckCircle2 size={13} aria-hidden />
                      : <Copy size={13} aria-hidden />}
                    <span aria-live="polite">{authCopyLabel}</span>
                  </button>
                </>
              ) : null}
            </div>
          )}
        </div>
        <div className="gen-actions">
          <button type="button" className="gen-pill" disabled={busy} onClick={() => void diagnose()}>
            <span className="gen-pill-lead"><Server size={16} /></span>
            <span className="gen-pill-label">Check</span>
          </button>
          <button type="button" className="gen-pill" disabled={busy} onClick={() => void setup()}>
            <span className="gen-pill-label">Set up</span>
          </button>
          <button type="button" className="gen-pill" disabled={busy} onClick={() => void save()}>
            <span className="gen-pill-label">Save</span>
          </button>
        </div>
      </div>
      </> : null}
      {report && (
        <>
          <div className="gen-card-divider" />
          <ul className="gen-doctor-list" aria-label="Worker checks">
            {report.checks.map((check) => (
              <li key={check.id} className={`gen-doctor-item is-${check.status}`}>
                <span className="gen-doctor-mark" aria-hidden="true">
                  {check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✕"}
                </span>
                <span className="gen-doctor-label">{check.label}</span>
                {check.detail && <span className="gen-doctor-detail">{check.detail}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      </fieldset>
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

function PromptContextControl(props: {
  settings: ChatPromptContextSettings;
  onChange: (settings: ChatPromptContextSettings) => Promise<void>;
}): JSX.Element {
  const [threadMode, setThreadMode] = useState<ChatPromptContextMode>(props.settings.thread.mode);
  const [threadLimit, setThreadLimit] = useState(String(props.settings.thread.limit ?? 0));
  const [timelineMode, setTimelineMode] = useState<ChatPromptContextMode>(props.settings.timeline.mode);
  const [timelineLimit, setTimelineLimit] = useState(String(props.settings.timeline.limit ?? 3));

  useEffect(() => {
    setThreadMode(props.settings.thread.mode);
    setThreadLimit(String(props.settings.thread.limit ?? 0));
    setTimelineMode(props.settings.timeline.mode);
    setTimelineLimit(String(props.settings.timeline.limit ?? 3));
  }, [props.settings]);

  const threadValidation = promptContextLimitValidation(threadMode, threadLimit);
  const timelineValidation = promptContextLimitValidation(timelineMode, timelineLimit);
  const draft = normalizeChatPromptContextSettings({
    thread: promptContextScopeDraft(threadMode, threadLimit),
    timeline: promptContextScopeDraft(timelineMode, timelineLimit)
  });
  const canSave = !threadValidation && !timelineValidation && JSON.stringify(draft) !== JSON.stringify(props.settings);

  return (
    <div className="gen-row-control prompt-context-control">
      <PromptContextScopeControl
        label="Thread"
        mode={threadMode}
        limit={threadLimit}
        validation={threadValidation}
        onModeChange={setThreadMode}
        onLimitChange={setThreadLimit}
      />
      <PromptContextScopeControl
        label="Timeline"
        mode={timelineMode}
        limit={timelineLimit}
        validation={timelineValidation}
        onModeChange={setTimelineMode}
        onLimitChange={setTimelineLimit}
      />
      <button
        type="button"
        className={`gen-timeout-save ${canSave ? "is-dirty" : ""}`}
        disabled={!canSave}
        onClick={() => void props.onChange(draft)}
      >
        Save
      </button>
    </div>
  );
}

function PromptContextScopeControl(props: {
  label: string;
  mode: ChatPromptContextMode;
  limit: string;
  validation?: string;
  onModeChange: (mode: ChatPromptContextMode) => void;
  onLimitChange: (limit: string) => void;
}): JSX.Element {
  const latest = props.mode === "latest_unseen";
  return (
    <div className="gen-timeout prompt-context-scope">
      <label className="prompt-context-select-wrap">
        <span className="sr-only">{props.label} prompt context mode</span>
        <select
          className="prompt-context-select"
          value={props.mode}
          onChange={(event) => props.onModeChange(event.target.value as ChatPromptContextMode)}
          aria-label={`${props.label} prompt context mode`}
        >
          <option value="off">{props.label}: Off</option>
          <option value="all_unseen">{props.label}: All unseen</option>
          <option value="latest_unseen">{props.label}: Latest unseen</option>
        </select>
        <ChevronDown aria-hidden="true" size={14} />
      </label>
      <div className="gen-timeout-field">
        <input
          className="gen-timeout-input"
          inputMode="numeric"
          value={latest ? props.limit : "0"}
          disabled={!latest}
          aria-label={`${props.label} prompt context limit`}
          onChange={(event) => props.onLimitChange(event.target.value)}
        />
        <span className="gen-timeout-unit">Msgs</span>
      </div>
      {props.validation && <div className="gen-timeout-error">{props.validation}</div>}
    </div>
  );
}

function promptContextScopeDraft(mode: ChatPromptContextMode, limit: string): ChatPromptContextScopeSettings {
  if (mode === "off") {
    return { mode: "off" };
  }
  if (mode === "all_unseen") {
    return { mode: "all_unseen" };
  }
  return { mode: "latest_unseen", limit: Number(limit.trim()) };
}

function promptContextLimitValidation(mode: ChatPromptContextMode, limit: string): string | undefined {
  if (mode !== "latest_unseen") {
    return undefined;
  }
  const trimmed = limit.trim();
  const parsed = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return "Use a whole number.";
  }
  if (parsed < 0 || parsed > CHAT_PROMPT_CONTEXT_LIMIT_MAX) {
    return `Use 0 to ${CHAT_PROMPT_CONTEXT_LIMIT_MAX} messages.`;
  }
  return undefined;
}

function ParticipantRequestDepthControl(props: {
  maxDepth: number;
  onChange: (maxDepth: number) => Promise<void>;
}): JSX.Element {
  const [depth, setDepth] = useState(String(props.maxDepth));
  const trimmed = depth.trim();
  const parsed = Number(trimmed);
  const validation = trimmed === ""
    ? undefined
    : !Number.isFinite(parsed) || !Number.isInteger(parsed)
      ? "Use a whole number."
      : parsed < CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_MIN || parsed > CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_MAX
        ? `Use ${CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_MIN} to ${CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_MAX} levels.`
        : undefined;
  const canSave = trimmed !== "" && !validation && parsed !== props.maxDepth;

  useEffect(() => {
    setDepth(String(props.maxDepth));
  }, [props.maxDepth]);

  return (
    <div className="gen-row-control">
      <div className="gen-timeout">
        <div className="gen-timeout-field">
          <input
            className="gen-timeout-input"
            inputMode="numeric"
            value={depth}
            aria-label="Member request max depth"
            title={PARTICIPANT_REQUEST_DEPTH_HELP}
            onChange={(event) => setDepth(event.target.value)}
          />
          <span className="gen-timeout-unit">Levels</span>
        </div>
        <button
          type="button"
          className={`gen-timeout-save ${canSave ? "is-dirty" : ""}`}
          disabled={!canSave}
          onClick={() => void props.onChange(parsed)}
        >
          Save
        </button>
      </div>
      {validation && <div className="gen-timeout-error">{validation}</div>}
    </div>
  );
}

function AutoWatchWakeLimitControl(props: {
  limit: number;
  onChange: (limit: number) => Promise<void>;
}): JSX.Element {
  const [limit, setLimit] = useState(String(props.limit));
  const trimmed = limit.trim();
  const parsed = Number(trimmed);
  const validation = trimmed === ""
    ? undefined
    : !Number.isFinite(parsed) || !Number.isInteger(parsed)
      ? "Use a whole number."
      : parsed < CHAT_AUTO_WATCH_WAKE_LIMIT_MIN || parsed > CHAT_AUTO_WATCH_WAKE_LIMIT_MAX
        ? `Use ${CHAT_AUTO_WATCH_WAKE_LIMIT_MIN} to ${CHAT_AUTO_WATCH_WAKE_LIMIT_MAX} runs.`
        : undefined;
  const canSave = trimmed !== "" && !validation && parsed !== props.limit;

  useEffect(() => {
    setLimit(String(props.limit));
  }, [props.limit]);

  return (
    <div className="gen-row-control">
      <div className="gen-timeout">
        <div className="gen-timeout-field">
          <input
            className="gen-timeout-input"
            inputMode="numeric"
            value={limit}
            aria-label="Auto-watch run limit"
            title={AUTO_WATCH_WAKE_LIMIT_HELP}
            onChange={(event) => setLimit(event.target.value)}
          />
          <span className="gen-timeout-unit">Runs</span>
        </div>
        <button
          type="button"
          className={`gen-timeout-save ${canSave ? "is-dirty" : ""}`}
          disabled={!canSave}
          onClick={() => void props.onChange(parsed)}
        >
          Save
        </button>
      </div>
      {validation && <div className="gen-timeout-error">{validation}</div>}
    </div>
  );
}

function ParticipantRequestPromptMaxControl(props: {
  maxChars: number;
  onChange: (maxChars: number) => Promise<void>;
}): JSX.Element {
  const [maxChars, setMaxChars] = useState(String(props.maxChars));
  const trimmed = maxChars.trim();
  const parsed = Number(trimmed);
  const validation = trimmed === ""
    ? undefined
    : !Number.isFinite(parsed) || !Number.isInteger(parsed)
      ? "Use a whole number."
      : parsed < CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_MIN || parsed > CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_MAX
        ? `Use ${CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_MIN.toLocaleString()} to ${CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_MAX.toLocaleString()} characters.`
        : undefined;
  const canSave = trimmed !== "" && !validation && parsed !== props.maxChars;

  useEffect(() => {
    setMaxChars(String(props.maxChars));
  }, [props.maxChars]);

  return (
    <div className="gen-row-control">
      <div className="gen-timeout">
        <div className="gen-timeout-field">
          <input
            className="gen-timeout-input"
            inputMode="numeric"
            value={maxChars}
            aria-label="Member request prompt max characters"
            title={PARTICIPANT_REQUEST_PROMPT_MAX_HELP}
            onChange={(event) => setMaxChars(event.target.value)}
          />
          <span className="gen-timeout-unit">Chars</span>
        </div>
        <button
          type="button"
          className={`gen-timeout-save ${canSave ? "is-dirty" : ""}`}
          disabled={!canSave}
          onClick={() => void props.onChange(parsed)}
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

import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bell, Check, ChevronDown, Code2, ExternalLink, FolderOpen, HelpCircle } from "lucide-react";

import type {
  AgentHealth,
  ChatCompletionNotificationSettings,
  ChatCompletionNotificationSettingsUpdate,
  ProviderKind,
  ProviderSettings,
  RepoFileOpenAction
} from "../../../shared/types";
import { CLI_AGENT_RUN_TIMEOUT_MAX_MS, CLI_AGENT_RUN_TIMEOUT_MIN_MS, cliAgentRunTimeoutHours } from "../../../shared/cliAgentRunSettings";
import {
  CHAT_COMPLETION_NOTIFICATION_MAX_THRESHOLD_MS,
  CHAT_COMPLETION_NOTIFICATION_MIN_THRESHOLD_MS,
  chatCompletionNotificationThresholdMinutes
} from "../../../shared/chatCompletionNotifications";

const CLI_ICON_URLS: Partial<Record<ProviderKind, string>> = {
  "codex-cli": new URL("../../assets/codex-cli.svg", import.meta.url).href,
  "claude-code": new URL("../../assets/claude-avatar.png", import.meta.url).href
};

export function GeneralSettingsSection(props: {
  providers: ProviderSettings[];
  agents: AgentHealth[];
  repoFileOpenAction?: RepoFileOpenAction;
  cliAgentRunTimeoutMs: number;
  chatCompletionNotifications: ChatCompletionNotificationSettings;
  updateProvider: (provider: ProviderSettings, patch: { enabled?: boolean }) => Promise<void>;
  setRepoFileOpenPreference: (action: RepoFileOpenAction | null) => Promise<void>;
  setCliAgentRunTimeoutMs: (timeoutMs: number) => Promise<void>;
  setChatCompletionNotifications: (update: ChatCompletionNotificationSettingsUpdate) => Promise<void>;
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
          <div className="gen-row gen-row-notifications">
            <div className="gen-row-text">
              <div className="gen-row-title">Participant completion notifications</div>
              <div className="gen-row-desc">Notify when a participant finishes a long turn. Optional webhook payload excludes response text.</div>
            </div>
            <ChatCompletionNotificationsControl
              settings={props.chatCompletionNotifications}
              onChange={props.setChatCompletionNotifications}
            />
          </div>
        </div>
      </section>
    </>
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

function ChatCompletionNotificationsControl(props: {
  settings: ChatCompletionNotificationSettings;
  onChange: (update: ChatCompletionNotificationSettingsUpdate) => Promise<void>;
}): JSX.Element {
  const currentMinutes = chatCompletionNotificationThresholdMinutes(props.settings.thresholdMs);
  const [enabled, setEnabled] = useState(props.settings.enabled);
  const [minutes, setMinutes] = useState(String(currentMinutes));
  const [webhookUrl, setWebhookUrl] = useState(props.settings.webhookUrl ?? "");
  const minMinutes = CHAT_COMPLETION_NOTIFICATION_MIN_THRESHOLD_MS / 60_000;
  const maxMinutes = CHAT_COMPLETION_NOTIFICATION_MAX_THRESHOLD_MS / 60_000;
  const trimmedMinutes = minutes.trim();
  const parsedMinutes = Number(trimmedMinutes);
  const trimmedWebhookUrl = webhookUrl.trim();
  const minuteValidation = trimmedMinutes === ""
    ? undefined
    : !Number.isFinite(parsedMinutes) || !Number.isInteger(parsedMinutes)
      ? "Use a whole number of minutes."
      : parsedMinutes < minMinutes || parsedMinutes > maxMinutes
        ? `Use ${minMinutes} to ${maxMinutes} minutes.`
        : undefined;
  const webhookValidation = trimmedWebhookUrl && !isHttpUrl(trimmedWebhookUrl)
    ? "Use an http or https URL."
    : undefined;
  const thresholdMs = parsedMinutes * 60_000;
  const normalizedWebhookUrl = trimmedWebhookUrl || undefined;
  const canSave = !minuteValidation && !webhookValidation && trimmedMinutes !== "" && (
    enabled !== props.settings.enabled ||
    thresholdMs !== props.settings.thresholdMs ||
    normalizedWebhookUrl !== props.settings.webhookUrl
  );

  useEffect(() => {
    setEnabled(props.settings.enabled);
    setMinutes(String(currentMinutes));
    setWebhookUrl(props.settings.webhookUrl ?? "");
  }, [props.settings.enabled, props.settings.thresholdMs, props.settings.webhookUrl, currentMinutes]);

  return (
    <div className="gen-row-control gen-notifications">
      <div className="gen-notifications-top">
        <label className="toggle gen-notifications-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span />
        </label>
        <div className="gen-timeout-field gen-notifications-minutes">
          <input
            className="gen-timeout-input"
            inputMode="numeric"
            value={minutes}
            aria-label="Notification threshold in minutes"
            onChange={(event) => setMinutes(event.target.value)}
          />
          <span className="gen-timeout-unit">Minutes</span>
        </div>
      </div>
      <div className="gen-notifications-webhook">
        <span className="gen-notifications-webhook-icon"><Bell size={15} /></span>
        <input
          className="gen-notifications-webhook-input"
          value={webhookUrl}
          placeholder="Phone webhook URL"
          aria-label="Phone webhook URL"
          onChange={(event) => setWebhookUrl(event.target.value)}
        />
      </div>
      {(minuteValidation || webhookValidation) && (
        <div className="gen-timeout-error">{minuteValidation ?? webhookValidation}</div>
      )}
      <button
        type="button"
        className={`gen-timeout-save gen-notifications-save ${canSave ? "is-dirty" : ""}`}
        disabled={!canSave}
        onClick={() => void props.onChange({
          enabled,
          thresholdMs,
          webhookUrl: normalizedWebhookUrl
        })}
      >
        Save
      </button>
    </div>
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
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

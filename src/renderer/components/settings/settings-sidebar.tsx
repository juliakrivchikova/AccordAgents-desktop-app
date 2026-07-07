import { ArrowLeft, Circle, FileText, KeyRound, ListChecks, Plug, Settings, SlidersHorizontal, Users } from "lucide-react";

import { cn } from "@/lib/utils";
import { SidebarPanelIcon } from "../shell/sidebar-panel-icon";
import type { SettingsSection } from "./settings-view";

const ACCORDAGENTS_MARK_URL = new URL("../../assets/accordagents-mark.png", import.meta.url).href;

const SETTINGS_NAV: Array<{ section: SettingsSection; label: string; icon: typeof Settings }> = [
  { section: "general", label: "General", icon: SlidersHorizontal },
  { section: "environment", label: "Environment", icon: KeyRound },
  { section: "roles", label: "Roles", icon: Circle },
  { section: "behavior-rules", label: "Rules", icon: ListChecks },
  { section: "saved-prompts", label: "Prompts", icon: FileText },
  { section: "plugins", label: "Plugins & Skills", icon: Plug },
  { section: "participants", label: "Participants", icon: Users }
];

export function SettingsSidebar(props: {
  section: SettingsSection;
  appVersion?: string;
  onSectionChange: (section: SettingsSection) => void;
  onBackToChats: () => void;
  onToggleSidebar?: () => void;
}): JSX.Element {
  return (
    <aside
      id="app-sidebar"
      data-shell="sidebar"
      className="flex min-h-0 flex-col text-foreground"
    >
      <div
        data-shell="sidebar-brand"
        className="flex h-[var(--app-header-height)] shrink-0 items-center justify-between gap-2 px-[var(--app-gutter)] text-sm font-semibold text-[var(--app-text-strong)]"
      >
        <div className="flex min-w-0 items-center gap-2">
          <img src={ACCORDAGENTS_MARK_URL} alt="" className="size-[22px] shrink-0 rounded-[6px]" aria-hidden="true" />
          <span className="min-w-0 truncate">AccordAgents</span>
        </div>
        {props.onToggleSidebar && (
          <button
            type="button"
            onClick={props.onToggleSidebar}
            title="Hide sidebar"
            aria-label="Hide sidebar"
            aria-controls="app-sidebar"
            aria-expanded="true"
            data-testid="sidebar-collapse-toggle"
            className={cn(
              "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground",
              "transition-colors hover:bg-[var(--app-surface-hover)] hover:text-[var(--app-text-strong)]",
              "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/45"
            )}
          >
            <SidebarPanelIcon />
          </button>
        )}
      </div>

      <div className="px-[var(--app-gutter-tight)] pt-3 pb-2">
        <button
          type="button"
          onClick={props.onBackToChats}
          data-testid="settings-back-to-chats"
          className={cn(
            "inline-flex h-8 w-full items-center justify-start gap-2 rounded-md",
            "bg-transparent px-2.5 text-[13px] font-medium text-[var(--app-text)]",
            "transition-colors hover:bg-[var(--app-surface-hover)] hover:text-[var(--app-text-strong)]",
            "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/45"
          )}
        >
          <ArrowLeft className="size-[15px] text-muted-foreground" aria-hidden />
          <span>Chats</span>
        </button>
      </div>

      <div className="px-[var(--app-gutter-tight)] pb-1 pt-2 text-[11.5px] font-semibold tracking-[0.01em] text-muted-foreground">
        Settings
      </div>

      <nav className="min-h-0 flex-1 px-[var(--app-gutter-tight)] pb-2" aria-label="Settings">
        <div className="flex min-w-0 flex-col gap-1">
          {SETTINGS_NAV.map((item) => {
            const Icon = item.icon;
            const selected = props.section === item.section;
            return (
              <button
                type="button"
                key={item.section}
                onClick={() => props.onSectionChange(item.section)}
                data-testid={`settings-nav-${item.section}`}
                data-selected={selected ? "true" : undefined}
                className={cn(
                  "inline-flex h-8 w-full items-center justify-start gap-2 rounded-md px-2.5 text-[13px] font-medium",
                  "transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/45",
                  selected
                    ? "bg-[var(--app-surface-active)] text-[var(--app-text-strong)]"
                    : "text-[var(--app-text)] hover:bg-[var(--app-surface-hover)] hover:text-[var(--app-text-strong)]"
                )}
              >
                <Icon className={cn("size-[15px]", selected ? "text-[var(--app-text-strong)]" : "text-muted-foreground")} aria-hidden />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <div className="shrink-0 px-[var(--app-gutter-tight)] py-2">
        <div
          className={cn(
            "inline-flex h-8 w-full items-center justify-start gap-2 rounded-md px-2.5 text-[13px] font-semibold",
            "bg-[var(--app-surface-active)] text-[var(--app-text-strong)]"
          )}
          aria-current="page"
        >
          <Settings className="size-[15px] text-[var(--app-text-strong)]" aria-hidden />
          <span>Settings</span>
          {props.appVersion && <span className="ml-auto shrink-0 text-[11px] font-medium text-muted-foreground">v{props.appVersion}</span>}
        </div>
      </div>
    </aside>
  );
}

import { ArrowLeft, Circle, Cloud, FileText, KeyRound, ListChecks, Plug, SlidersHorizontal, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { SidebarToggleButton } from "../shell/sidebar-toggle-button";
import type { SettingsSection } from "./settings-view";
import { useAwsAttention } from "./use-aws-attention";

const ACCORDAGENTS_MARK_URL = new URL("../../assets/accordagents-mark.png", import.meta.url).href;

const SETTINGS_NAV: Array<{ section: SettingsSection; label: string; icon: LucideIcon }> = [
  { section: "general", label: "General", icon: SlidersHorizontal },
  { section: "aws", label: "AWS", icon: Cloud },
  { section: "environment", label: "Environment", icon: KeyRound },
  { section: "roles", label: "Roles", icon: Circle },
  { section: "behavior-rules", label: "Rules", icon: ListChecks },
  { section: "saved-prompts", label: "Prompts", icon: FileText },
  { section: "plugins", label: "Plugins & Skills", icon: Plug },
  { section: "participants", label: "Members", icon: Users }
];

export function SettingsSidebar(props: {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onBackToChats: () => void;
  onToggleSidebar?: () => void;
  footerActions?: ReactNode;
}): JSX.Element {
  const awsAttention = useAwsAttention();
  return (
    <aside
      id="app-sidebar"
      data-shell="sidebar"
      className="flex min-h-0 flex-col text-foreground"
    >
      <div data-shell="sidebar-brand" data-titlebar className="app-titlebar-row sidebar-brand-row">
        <div className="flex min-w-0 items-center gap-2">
          <img src={ACCORDAGENTS_MARK_URL} alt="" className="size-5 shrink-0 rounded-[5px]" aria-hidden="true" />
          <span className="min-w-0 truncate">AccordAgents</span>
        </div>
        {props.onToggleSidebar && <SidebarToggleButton expanded onToggle={props.onToggleSidebar} />}
      </div>

      <div className="px-[var(--app-gutter-tight)] pt-2 pb-2">
        <button
          type="button"
          onClick={props.onBackToChats}
          data-testid="settings-back-to-chats"
          className={cn(
            "inline-flex h-8 w-full items-center justify-start gap-2 rounded-md",
            "bg-transparent px-2.5 text-[13px] font-medium text-[var(--app-text)]",
            "transition-colors hover:bg-[var(--app-surface-hover)] hover:text-[var(--app-text-strong)]",
            "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
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
                  "transition-colors focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]",
                  selected
                    ? "bg-[var(--app-surface-active)] text-[var(--app-text-strong)]"
                    : "text-[var(--app-text)] hover:bg-[var(--app-surface-hover)] hover:text-[var(--app-text-strong)]"
                )}
              >
                <Icon className={cn("size-[15px]", selected ? "text-[var(--app-text-strong)]" : "text-muted-foreground")} aria-hidden />
                <span>{item.label}</span>
                {item.section === "aws" && awsAttention ? (
                  <span className="settings-nav-attention" data-testid="settings-nav-aws-attention"><span className="sr-only">, needs attention</span></span>
                ) : null}
              </button>
            );
          })}
        </div>
      </nav>
      {props.footerActions && (
        <div className="flex shrink-0 items-center justify-end gap-1 border-t border-[var(--app-shell-border)] px-[var(--app-gutter-tight)] py-2">
          {props.footerActions}
        </div>
      )}
    </aside>
  );
}

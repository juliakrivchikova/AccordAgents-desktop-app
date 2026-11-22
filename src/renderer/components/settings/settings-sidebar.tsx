import { ArrowLeftIcon, BellRingingIcon, BrainIcon, CalendarDotsIcon, CircleIcon, CloudIcon, FileTextIcon, KeyIcon, ListChecksIcon, PlugIcon, SlidersHorizontalIcon, UsersIcon } from "@phosphor-icons/react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { SidebarToggleButton } from "../shell/sidebar-toggle-button";
import type { SettingsSection } from "./settings-view";
import { useAwsAttention } from "./use-aws-attention";

const ROW = cn(
  "flex h-7 w-full items-center gap-2 rounded-ui-8 px-2 text-left text-ui-13 text-ui-text",
  "transition-colors duration-120 ease-ui-out hover:bg-ui-row-hover",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-focus-ring"
);


const SETTINGS_NAV: Array<{ section: SettingsSection; label: string; icon: PhosphorIcon }> = [
  { section: "general", label: "General", icon: SlidersHorizontalIcon },
  { section: "aws", label: "AWS", icon: CloudIcon },
  { section: "environment", label: "Environment", icon: KeyIcon },
  { section: "scripts", label: "Scheduled Tasks", icon: CalendarDotsIcon },
  { section: "alerts", label: "Alerts", icon: BellRingingIcon },
  { section: "roles", label: "Roles", icon: CircleIcon },
  { section: "behavior-rules", label: "Rules", icon: ListChecksIcon },
  { section: "saved-prompts", label: "Prompts", icon: FileTextIcon },
  { section: "plugins", label: "Plugins & Skills", icon: PlugIcon },
  { section: "memory", label: "Memory", icon: BrainIcon },
  { section: "participants", label: "Members", icon: UsersIcon }
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
    <aside id="app-sidebar" data-shell="sidebar" className="flex min-h-0 flex-col bg-ui-sidebar text-ui-text">
      <div data-shell="sidebar-brand" data-titlebar className="app-titlebar-row sidebar-brand-row">
        {/* No name by the lights: the toggle sits where the collapsed
            sidebar keeps it, so it never moves (the User, 2026-11-22). */}
        {props.onToggleSidebar && <SidebarToggleButton expanded onToggle={props.onToggleSidebar} />}
      </div>

      <div className="px-2 pt-1">
        <button type="button" onClick={props.onBackToChats} data-testid="settings-back-to-chats" className={ROW}>
          <ArrowLeftIcon className="size-4 shrink-0 text-ui-text-2" aria-hidden />
          <span>Chats</span>
        </button>
      </div>

      <div className="flex h-6 items-center px-4 pt-2 text-ui-12 font-medium text-ui-text-3">Settings</div>

      <nav className="min-h-0 flex-1 px-2 pb-2 pt-1" aria-label="Settings">
        <div className="flex min-w-0 flex-col gap-px">
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
                aria-current={selected ? "page" : undefined}
                className={cn(ROW, selected && "bg-ui-row-active text-ui-select-fg hover:bg-ui-row-active")}
              >
                <Icon className={cn("size-4 shrink-0", selected ? "text-ui-select-fg" : "text-ui-text-2")} aria-hidden />
                <span className="min-w-0 truncate">{item.label}</span>
                {item.section === "aws" && awsAttention ? (
                  <span className="settings-nav-attention" data-testid="settings-nav-aws-attention"><span className="sr-only">, needs attention</span></span>
                ) : null}
              </button>
            );
          })}
        </div>
      </nav>
      {props.footerActions && (
        <div className="flex h-11 shrink-0 items-center justify-end gap-0.5 border-t border-ui-border-subtle px-2">
          {props.footerActions}
        </div>
      )}
    </aside>
  );
}

import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export function SidebarNavItem({
  icon: Icon,
  label,
  ariaLabel,
  disabled,
  badge,
  testId,
  onClick
}: {
  icon: LucideIcon;
  label: string;
  ariaLabel?: string;
  disabled?: boolean;
  badge?: string;
  testId: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      data-testid={testId}
      className={cn(
        "inline-flex h-8 w-full items-center justify-start gap-2 rounded-md px-2.5 text-[13px] font-medium",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/45",
        "text-[var(--app-text)] hover:bg-[var(--app-surface-hover)] hover:text-[var(--app-text-strong)]"
      )}
    >
      <Icon className="size-[15px] shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {badge && (
        <span
          className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--app-accent)] px-1.5 text-[11px] font-semibold leading-none text-[var(--app-primary-fg)]"
          aria-hidden="true"
          data-testid={`${testId}-badge`}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

export function formatBadgeCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

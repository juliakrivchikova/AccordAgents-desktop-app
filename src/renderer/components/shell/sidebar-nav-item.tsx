import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

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
  icon: PhosphorIcon;
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
        "flex h-7 w-full items-center gap-2 rounded-ui-8 px-2 text-left text-ui-13 text-ui-text",
        "transition-colors duration-120 ease-ui-out hover:bg-ui-row-hover",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-focus-ring"
      )}
    >
      <Icon className="size-4 shrink-0 text-ui-text-2" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge && (
        <span
          className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-ui-muted px-1.5 text-ui-11 font-medium tabular-nums text-ui-text-2"
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

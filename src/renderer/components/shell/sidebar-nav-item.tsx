import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

import { cn } from "@/lib/utils";

export function SidebarNavItem({
  icon: Icon,
  label,
  disabled,
  testId,
  onClick
}: {
  icon: PhosphorIcon;
  label: string;
  disabled?: boolean;
  testId: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
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
    </button>
  );
}

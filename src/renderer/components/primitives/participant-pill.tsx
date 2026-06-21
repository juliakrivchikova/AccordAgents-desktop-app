import * as React from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

export type ParticipantStatus = "idle" | "running" | "done" | "error" | "disabled";

const STATUS_DOT: Record<ParticipantStatus, string> = {
  idle: "bg-[var(--app-muted-subtle)]",
  running: "bg-[var(--app-accent)] animate-pulse",
  done: "bg-[var(--app-success)]",
  error: "bg-[var(--app-danger)]",
  disabled: "bg-[var(--app-border-strong)]"
};

export interface ParticipantPillProps extends React.ComponentProps<"button"> {
  name: string;
  handle?: string;
  avatarUrl?: string;
  initials?: string;
  status?: ParticipantStatus;
  selected?: boolean;
  asButton?: boolean;
  size?: "sm" | "md";
}

export const ParticipantPill = React.forwardRef<HTMLButtonElement, ParticipantPillProps>(
  function ParticipantPill(
    {
      name,
      handle,
      avatarUrl,
      initials,
      status,
      selected,
      asButton = true,
      size = "md",
      className,
      onClick,
      disabled,
      ...rest
    },
    ref
  ) {
    const isInteractive = asButton && Boolean(onClick);
    const fallbackInitials = (initials ?? name.slice(0, 2)).toUpperCase();
    const padding = size === "sm" ? "h-6 pl-0.5 pr-2 text-[11px]" : "h-7 pl-0.5 pr-2.5 text-xs";
    const avatarSize = size === "sm" ? "size-5" : "size-6";
    const baseClass = cn(
      "inline-flex items-center gap-1.5 rounded-full border border-border bg-background font-medium",
      "text-foreground transition-colors",
      padding,
      isInteractive &&
        "cursor-pointer hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
      selected && "border-[var(--app-accent)] bg-[var(--app-accent-soft)] text-[var(--app-text-strong)]",
      disabled && "cursor-not-allowed opacity-50 hover:bg-background",
      className
    );

    const inner = (
      <>
        <Avatar className={cn(avatarSize, "shrink-0 after:hidden")}>
          {avatarUrl ? <AvatarImage src={avatarUrl} alt={name} /> : null}
          <AvatarFallback className="text-[10px]">{fallbackInitials}</AvatarFallback>
        </Avatar>
        <span className="truncate">{handle ? `@${handle}` : name}</span>
        {status ? (
          <span
            className={cn("ml-0.5 inline-block size-1.5 shrink-0 rounded-full", STATUS_DOT[status])}
            aria-hidden
          />
        ) : null}
      </>
    );

    if (isInteractive) {
      return (
        <button
          ref={ref}
          type="button"
          onClick={onClick}
          disabled={disabled}
          data-selected={selected ? "true" : undefined}
          data-status={status}
          className={baseClass}
          {...rest}
        >
          {inner}
        </button>
      );
    }

    return (
      <span
        data-selected={selected ? "true" : undefined}
        data-status={status}
        className={baseClass}
      >
        {inner}
      </span>
    );
  }
);

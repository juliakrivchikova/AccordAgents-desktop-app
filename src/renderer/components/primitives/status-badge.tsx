import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const statusBadgeVariants = cva(
  "inline-flex h-5 items-center gap-1 rounded-full border px-2 text-[11px] font-semibold leading-none whitespace-nowrap shadow-[inset_0_1px_0_color-mix(in_srgb,var(--highlight-color)_22%,transparent)] [&>svg]:text-current [&>svg]:stroke-[2.35]",
  {
    variants: {
      tone: {
        neutral:
          "border-[var(--app-status-neutral-border)] bg-[var(--app-status-neutral-bg)] text-[var(--app-status-neutral-text)]",
        info:
          "border-[var(--app-status-info-border)] bg-[var(--app-status-info-bg)] text-[var(--app-status-info-text)]",
        success:
          "border-[var(--app-status-success-border)] bg-[var(--app-status-success-bg)] text-[var(--app-status-success-text)]",
        warning:
          "border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-bg)] text-[var(--app-status-warning-text)]",
        danger:
          "border-[var(--app-status-danger-border)] bg-[var(--app-status-danger-bg)] text-[var(--app-status-danger-text)]",
        muted:
          "border-[var(--app-status-muted-border)] bg-[var(--app-status-muted-bg)] text-[var(--app-status-muted-text)]"
      },
      emphasis: {
        soft: "",
        outline:
          "bg-transparent border border-current/30"
      }
    },
    defaultVariants: {
      tone: "neutral",
      emphasis: "soft"
    }
  }
);

export type StatusBadgeTone = NonNullable<VariantProps<typeof statusBadgeVariants>["tone"]>;
export type StatusBadgeEmphasis = NonNullable<VariantProps<typeof statusBadgeVariants>["emphasis"]>;

export interface StatusBadgeProps extends React.ComponentProps<"span"> {
  tone?: StatusBadgeTone;
  emphasis?: StatusBadgeEmphasis;
  icon?: LucideIcon;
  uppercase?: boolean;
}

export const StatusBadge = ({
  tone,
  emphasis,
  icon: Icon,
  uppercase,
  className,
  children,
  ...rest
}: StatusBadgeProps): JSX.Element => {
  const resolvedTone = tone ?? "neutral";
  const resolvedEmphasis = emphasis ?? "soft";

  return (
    <Badge
      asChild
      variant="outline"
      className={cn(
        statusBadgeVariants({ tone: resolvedTone, emphasis: resolvedEmphasis }),
        "status-badge",
        uppercase && "tracking-wide uppercase",
        className
      )}
    >
      <span data-status-tone={resolvedTone} data-status-emphasis={resolvedEmphasis} {...rest}>
        {Icon ? <Icon className="size-3" aria-hidden /> : null}
        {children}
      </span>
    </Badge>
  );
};

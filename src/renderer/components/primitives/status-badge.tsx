import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const statusBadgeVariants = cva(
  "inline-flex h-5 items-center gap-1 rounded-full border px-2 text-[11px] font-semibold leading-none whitespace-nowrap shadow-[inset_0_1px_0_color-mix(in_srgb,#fff_18%,transparent)]",
  {
    variants: {
      tone: {
        neutral:
          "border-[var(--app-border)] bg-[var(--app-surface-hover)] text-[var(--app-text)]",
        info:
          "border-[var(--app-accent-border)] bg-[var(--app-accent-soft)] text-[var(--app-accent)]",
        success:
          "border-[var(--app-success-border)] bg-[var(--app-success-soft)] text-[var(--app-success)]",
        warning:
          "border-[var(--app-warning-border)] bg-[var(--app-warning-soft)] text-[var(--app-warning)]",
        danger:
          "border-[var(--app-danger-border)] bg-[var(--app-danger-soft)] text-[var(--app-danger)]",
        muted:
          "border-transparent bg-transparent text-[var(--app-muted)]"
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
}: StatusBadgeProps): JSX.Element => (
  <Badge
    asChild
    className={cn(
      statusBadgeVariants({ tone, emphasis }),
      uppercase && "tracking-wide uppercase",
      className
    )}
  >
    <span {...rest}>
      {Icon ? <Icon className="size-3" aria-hidden /> : null}
      {children}
    </span>
  </Badge>
);

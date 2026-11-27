import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const progressBarFillVariants = cva("block h-full rounded-full", {
  variants: {
    tone: {
      neutral: "bg-ui-text-3",
      warning: "bg-ui-warning",
      danger: "bg-ui-danger"
    }
  },
  defaultVariants: {
    tone: "neutral"
  }
});

export interface ProgressBarProps extends VariantProps<typeof progressBarFillVariants> {
  /** The share done, 0 to 100. */
  value: number;
  className?: string;
  /** Read out as an image; without it the bar is decoration. */
  label?: string;
}

/** A thin bar filled from the left with a share, its fill in its tone (the
 *  linear twin of ProgressRing). It never animates. */
export const ProgressBar = ({ value, tone, className, label }: ProgressBarProps): JSX.Element => (
  <span
    data-slot="progress-bar"
    className={cn("block h-1 w-full overflow-hidden rounded-full bg-ui-muted", className)}
    role={label ? "img" : undefined}
    aria-label={label}
    aria-hidden={label ? undefined : true}
  >
    <span className={progressBarFillVariants({ tone })} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
  </span>
);

import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const progressRingArcVariants = cva("fill-none", {
  variants: {
    tone: {
      neutral: "stroke-ui-text-2",
      warning: "stroke-ui-warning",
      danger: "stroke-ui-danger"
    }
  },
  defaultVariants: {
    tone: "neutral"
  }
});

/** The ring's geometry in its 14-unit box: an outer edge of 13. */
const RADIUS = 5.25;
const STROKE = 2.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export interface ProgressRingProps extends VariantProps<typeof progressRingArcVariants> {
  /** The share done, 0 to 100. None draws the empty track: not known yet. */
  value?: number;
  /** Side in pixels: 14 as an icon in a 28px control. */
  size?: number;
  className?: string;
  /** Read out as an image; without it the ring is decoration. */
  label?: string;
}

/**
 * A small ring that fills clockwise from 12 o'clock with a share (chosen by
 * the User for plan usage, 2026-11-27): the track in the border color, the
 * arc in its tone. It never animates and keeps its size whatever it shows.
 */
export const ProgressRing = ({ value, tone, size = 14, className, label }: ProgressRingProps): JSX.Element => {
  const share = value === undefined ? 0 : Math.max(0, Math.min(100, value)) / 100;
  const full = share >= 1;
  return (
    <svg
      data-slot="progress-ring"
      className={cn("block shrink-0 -rotate-90", className)}
      width={size}
      height={size}
      viewBox="0 0 14 14"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle className="fill-none stroke-ui-border" cx="7" cy="7" r={RADIUS} strokeWidth={STROKE} />
      {share > 0 && (
        <circle
          className={progressRingArcVariants({ tone })}
          cx="7"
          cy="7"
          r={RADIUS}
          strokeWidth={STROKE}
          strokeLinecap={full ? "butt" : "round"}
          strokeDasharray={`${full ? CIRCUMFERENCE : share * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
        />
      )}
    </svg>
  );
};

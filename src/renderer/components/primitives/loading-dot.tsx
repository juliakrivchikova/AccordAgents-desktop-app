import * as React from "react";

import { cn } from "@/lib/utils";

const DOT_BASE = "inline-block size-1.5 rounded-full bg-current opacity-60 animate-pulse";

export interface LoadingDotProps extends React.ComponentProps<"span"> {
  label?: string;
}

export const LoadingDot = ({ label, className, ...rest }: LoadingDotProps): JSX.Element => (
  <span
    className={cn(
      "inline-flex items-center gap-1 text-muted-foreground",
      className
    )}
    role={label ? "status" : undefined}
    aria-label={label}
    {...rest}
  >
    <span className={DOT_BASE} style={{ animationDelay: "0ms" }} aria-hidden />
    <span className={DOT_BASE} style={{ animationDelay: "150ms" }} aria-hidden />
    <span className={DOT_BASE} style={{ animationDelay: "300ms" }} aria-hidden />
  </span>
);

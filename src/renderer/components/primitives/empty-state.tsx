import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

interface EmptyStateRootProps extends React.ComponentProps<"div"> {
  size?: "sm" | "md";
}

const EmptyStateRoot = ({ size = "md", className, children, ...rest }: EmptyStateRootProps): JSX.Element => (
  <div
    className={cn(
      "mx-auto flex w-full max-w-md flex-col items-center justify-center gap-3 text-center",
      size === "sm" ? "py-6" : "py-12",
      className
    )}
    {...rest}
  >
    {children}
  </div>
);

interface EmptyStateIconProps {
  icon: LucideIcon;
  className?: string;
}

const EmptyStateIcon = ({ icon: Icon, className }: EmptyStateIconProps): JSX.Element => (
  <span
    className={cn(
      "inline-flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground",
      className
    )}
  >
    <Icon className="size-4" aria-hidden />
  </span>
);

const EmptyStateTitle = ({ className, ...rest }: React.ComponentProps<"div">): JSX.Element => (
  <div className={cn("text-sm font-medium text-foreground", className)} {...rest} />
);

const EmptyStateBody = ({ className, ...rest }: React.ComponentProps<"p">): JSX.Element => (
  <p
    className={cn("max-w-sm text-xs leading-relaxed text-muted-foreground", className)}
    {...rest}
  />
);

const EmptyStateActions = ({ className, ...rest }: React.ComponentProps<"div">): JSX.Element => (
  <div className={cn("mt-2 flex items-center gap-2", className)} {...rest} />
);

export const EmptyState = Object.assign(EmptyStateRoot, {
  Icon: EmptyStateIcon,
  Title: EmptyStateTitle,
  Body: EmptyStateBody,
  Actions: EmptyStateActions
});

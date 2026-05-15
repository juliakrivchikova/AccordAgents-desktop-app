import * as React from "react";
import { AlertCircle, AlertTriangle, Info } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

export type NoticeTone = "info" | "warning" | "error";

const TONE_CLASS: Record<NoticeTone, string> = {
  info: "border-[var(--app-accent)]/30 bg-[var(--app-accent-soft)] text-[var(--app-text-strong)]",
  warning: "border-[var(--app-warning)]/30 bg-[var(--app-warning-soft)] text-[var(--app-text-strong)]",
  error: "border-[var(--app-danger)]/30 bg-[var(--app-danger-soft)] text-[var(--app-text-strong)]"
};

const TONE_ICON: Record<NoticeTone, LucideIcon> = {
  info: Info,
  warning: AlertTriangle,
  error: AlertCircle
};

const TONE_ICON_CLASS: Record<NoticeTone, string> = {
  info: "text-[var(--app-accent)]",
  warning: "text-[var(--app-warning)]",
  error: "text-[var(--app-danger)]"
};

export interface NoticeProps extends Omit<React.ComponentProps<"div">, "title"> {
  tone?: NoticeTone;
  title?: React.ReactNode;
  icon?: LucideIcon;
}

export const Notice = ({
  tone = "info",
  title,
  icon,
  className,
  children,
  ...rest
}: NoticeProps): JSX.Element => {
  const Icon = icon ?? TONE_ICON[tone];
  return (
    <Alert className={cn(TONE_CLASS[tone], className)} {...rest}>
      <Icon className={cn("size-4", TONE_ICON_CLASS[tone])} aria-hidden />
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      {children ? <AlertDescription>{children}</AlertDescription> : null}
    </Alert>
  );
};

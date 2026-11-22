import * as React from "react";
import { WarningCircleIcon, WarningIcon, InfoIcon } from "@phosphor-icons/react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

export type NoticeTone = "info" | "warning" | "error";

const TONE_CLASS: Record<NoticeTone, string> = {
  info: "border-[var(--app-accent)]/30 bg-[var(--app-accent-soft)] text-[var(--app-text-strong)]",
  warning: "border-[var(--app-warning)]/30 bg-[var(--app-warning-soft)] text-[var(--app-text-strong)]",
  error: "border-[var(--app-danger)]/30 bg-[var(--app-danger-soft)] text-[var(--app-text-strong)]"
};

const TONE_ICON: Record<NoticeTone, PhosphorIcon> = {
  info: InfoIcon,
  warning: WarningIcon,
  error: WarningCircleIcon
};

const TONE_ICON_CLASS: Record<NoticeTone, string> = {
  info: "text-ui-link",
  warning: "text-[var(--app-warning)]",
  error: "text-[var(--app-danger)]"
};

export interface NoticeProps extends Omit<React.ComponentProps<"div">, "title"> {
  tone?: NoticeTone;
  title?: React.ReactNode;
  icon?: PhosphorIcon;
  action?: React.ReactNode;
}

export const Notice = ({
  tone = "info",
  title,
  icon,
  action,
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
      {action ? <AlertAction>{action}</AlertAction> : null}
    </Alert>
  );
};

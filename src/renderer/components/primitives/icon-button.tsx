import * as React from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// "xs" is the compact size for rows and toolbars (24px); "sm" and "md" are the
// header and panel size (28px). Both names stay so existing call sites keep
// their meaning of "small" versus "regular".
export type IconButtonSize = "xs" | "sm" | "md";
export type IconButtonTone = "default" | "danger";

export type IconButtonIcon = React.ComponentType<{
  className?: string;
  strokeWidth?: number | string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

export interface IconButtonProps
  extends Omit<React.ComponentProps<"button">, "children"> {
  label: string;
  icon: IconButtonIcon;
  iconClassName?: string;
  size?: IconButtonSize;
  // Danger turns the icon red on hover; the shape never changes.
  tone?: IconButtonTone;
  // Floating buttons sit on top of content (a document, the timeline) and keep
  // a surface so they stay readable; everything else is a bare icon.
  floating?: boolean;
  tooltip?: React.ReactNode;
  pressed?: boolean;
}

// The one icon-only button of the app: no border and no tinted background at
// rest, a grey surface on hover and while pressed or open.
export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    icon: Icon,
    iconClassName,
    size = "sm",
    tone = "default",
    floating = false,
    tooltip,
    pressed,
    className,
    type = "button",
    ...rest
  },
  ref
) {
  const button = (
    <button
      ref={ref}
      type={type}
      data-slot="icon-button"
      data-size={size === "xs" ? "xs" : "md"}
      data-tone={tone === "danger" ? "danger" : undefined}
      data-floating={floating ? "true" : undefined}
      aria-label={label}
      aria-pressed={pressed}
      title={tooltip ? undefined : label}
      className={cn("aa-icon-button", className)}
      {...rest}
    >
      <Icon className={iconClassName} strokeWidth={1.75} aria-hidden />
    </button>
  );

  if (!tooltip) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
});

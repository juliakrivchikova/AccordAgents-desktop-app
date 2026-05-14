import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type IconButtonSize = "xs" | "sm" | "md";
export type IconButtonVariant = "ghost" | "outline" | "secondary";

const SIZE_TO_BUTTON_SIZE: Record<IconButtonSize, "icon-xs" | "icon-sm" | "icon"> = {
  xs: "icon-xs",
  sm: "icon-sm",
  md: "icon"
};

const SIZE_TO_ICON_CLASS: Record<IconButtonSize, string> = {
  xs: "size-3.5",
  sm: "size-4",
  md: "size-4"
};

export interface IconButtonProps
  extends Omit<React.ComponentProps<"button">, "children"> {
  label: string;
  icon: LucideIcon;
  iconClassName?: string;
  size?: IconButtonSize;
  variant?: IconButtonVariant;
  tooltip?: React.ReactNode;
  pressed?: boolean;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    icon: Icon,
    iconClassName,
    size = "sm",
    variant = "ghost",
    tooltip,
    pressed,
    className,
    ...rest
  },
  ref
) {
  const button = (
    <Button
      ref={ref}
      type="button"
      variant={variant}
      size={SIZE_TO_BUTTON_SIZE[size]}
      aria-label={label}
      aria-pressed={pressed}
      title={tooltip ? undefined : label}
      className={cn(className)}
      {...rest}
    >
      <Icon className={cn(SIZE_TO_ICON_CLASS[size], iconClassName)} aria-hidden />
      <span className="sr-only">{label}</span>
    </Button>
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

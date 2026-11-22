import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-ui-8 border border-transparent bg-clip-padding text-ui-13 font-medium whitespace-nowrap outline-none select-none transition-[background-color,border-color,color,transform] duration-120 ease-ui-out focus-visible:ring-2 focus-visible:ring-ui-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-ui-bg active:not-aria-[haspopup]:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-ui-primary text-ui-primary-fg hover:bg-ui-primary-hover disabled:opacity-100 disabled:bg-ui-subtle disabled:text-ui-text-disabled",
        outline:
          "border-ui-border bg-ui-bg text-ui-text hover:bg-ui-row-hover aria-expanded:bg-ui-row-hover",
        secondary:
          "border-ui-border bg-ui-subtle text-ui-text hover:bg-ui-row-hover aria-expanded:bg-ui-row-hover",
        ghost:
          "bg-transparent text-ui-text hover:bg-ui-row-hover aria-expanded:bg-ui-row-hover",
        destructive:
          "bg-transparent text-ui-danger hover:bg-ui-danger/10",
        link: "text-ui-link underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 gap-1.5 px-3",
        xs: "h-6 gap-1 rounded-ui-8 px-2 text-ui-12 [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-7 gap-1.5 px-2.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-8 gap-1.5 px-3.5",
        icon: "size-8",
        "icon-xs": "size-6 rounded-ui-8 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-7",
        "icon-lg": "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}, ref) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      ref={ref}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
})

export { Button, buttonVariants }

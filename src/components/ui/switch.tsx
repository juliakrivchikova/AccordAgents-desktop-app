import * as React from "react"

import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"

export interface SwitchProps extends Omit<React.ComponentProps<"input">, "type" | "size"> {
  /** Shown in a delayed tooltip over the whole switch. */
  title?: string
}

/**
 * The app's one switch: a native checkbox (keyboard, form and test
 * semantics unchanged) drawn as a 28 by 16 track with a sliding knob.
 */
const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(function Switch({ className, title, ...props }, ref) {
  const control = (
    <label className={cn("toggle", className)} data-slot="switch">
      <input ref={ref} type="checkbox" aria-description={title} {...props} />
      <span aria-hidden="true" />
    </label>
  )
  if (!title) return control
  return (
    <Tooltip>
      <TooltipTrigger asChild>{control}</TooltipTrigger>
      <TooltipContent side="top">{title}</TooltipContent>
    </Tooltip>
  )
})

export { Switch }

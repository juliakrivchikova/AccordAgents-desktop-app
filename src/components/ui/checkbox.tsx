import * as React from "react"
import { CheckIcon, MinusIcon } from "@phosphor-icons/react"

import { cn } from "@/lib/utils"

export interface CheckboxProps extends Omit<React.ComponentProps<"input">, "type" | "size"> {
  /** Some of what it stands for is chosen (a group's box): drawn as a dash,
   *  read as "mixed". */
  indeterminate?: boolean
}

/**
 * The app's one checkbox: a native checkbox (keyboard, form and test
 * semantics unchanged), 14px, radius 4, filled with the primary color when
 * on, as the switch is.
 */
const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, indeterminate = false, checked, ...props },
  ref
) {
  const inner = React.useRef<HTMLInputElement>(null)
  React.useImperativeHandle(ref, () => inner.current as HTMLInputElement)
  // "Mixed" is a DOM property only, not an attribute.
  React.useEffect(() => {
    if (inner.current) inner.current.indeterminate = indeterminate
  }, [indeterminate])
  const Mark = indeterminate ? MinusIcon : checked ? CheckIcon : undefined
  return (
    <span data-slot="checkbox" className={cn("relative inline-grid size-3.5 shrink-0 place-items-center", className)}>
      <input
        ref={inner}
        type="checkbox"
        checked={checked}
        className={cn(
          "absolute inset-0 m-0 cursor-pointer appearance-none rounded-ui-4 border border-ui-border-strong bg-ui-bg",
          "transition-colors duration-120 ease-ui-out",
          "checked:border-ui-primary checked:bg-ui-primary indeterminate:border-ui-primary indeterminate:bg-ui-primary",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-ui-bg",
          "disabled:cursor-default disabled:opacity-40"
        )}
        {...props}
      />
      {Mark && <Mark weight="bold" className="pointer-events-none relative size-2.5 text-ui-primary-fg" aria-hidden />}
    </span>
  )
})

export { Checkbox }

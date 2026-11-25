import * as React from "react"

import { cn } from "@/lib/utils"

// React 18 gives a function component no `ref` prop: without forwardRef a
// ref to the field stays null (the chat composer's focus and caret).
const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        data-slot="textarea"
        className={cn(
          "flex field-sizing-content min-h-16 w-full rounded-ui-8 border border-ui-border bg-ui-bg px-2.5 py-2 text-ui-13 transition-[border-color,box-shadow] duration-120 ease-ui-out outline-none placeholder:text-ui-text-3 focus-visible:border-ui-primary focus-visible:ring-3 focus-visible:ring-ui-focus disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
          className
        )}
        {...props}
      />
    )
  }
)

export { Textarea }

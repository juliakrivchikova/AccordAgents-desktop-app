import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-7 w-full min-w-0 rounded-ui-8 border border-ui-border bg-ui-bg px-2.5 py-1 text-ui-13 text-ui-text transition-[border-color,box-shadow] duration-120 ease-ui-out outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-ui-text-3 focus-visible:border-ui-primary focus-visible:ring-3 focus-visible:ring-ui-focus disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-ui-subtle disabled:text-ui-text-disabled aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }

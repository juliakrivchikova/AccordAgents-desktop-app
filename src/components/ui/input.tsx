import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-[var(--app-border-strong)] bg-[var(--app-surface)] px-2.5 py-1 text-sm text-[var(--app-text)] shadow-[inset_0_1px_0_color-mix(in_srgb,#fff_60%,transparent)] transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-[var(--app-muted-subtle)] hover:border-[var(--app-accent-border)] focus-visible:border-[var(--app-accent)] focus-visible:ring-3 focus-visible:ring-ring/35 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-[var(--app-surface-subtle)] disabled:text-[var(--app-muted-subtle)] disabled:opacity-70 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:shadow-none dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }

import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// The app's own scales (app-theme.css @theme): without them twMerge reads
// text-ui-13 (a size) and text-ui-text (a color) as one group and drops one.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["ui-11", "ui-12", "ui-13", "ui-14", "ui-16", "ui-20"],
      radius: ["ui-4", "ui-6", "ui-8", "ui-12"],
      shadow: ["ui-sm", "ui-md", "ui-lg"],
      ease: ["ui-out", "ui-in-out"]
    }
  }
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

import type { SVGProps } from "react";

import { cn } from "@/lib/utils";

export function SidebarPanelIcon({ className, ...props }: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg
      className={cn("size-[17px]", className)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <path d="M9 3.5v17" />
    </svg>
  );
}

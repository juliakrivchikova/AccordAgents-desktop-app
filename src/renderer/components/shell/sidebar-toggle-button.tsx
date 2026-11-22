import { SidebarSimpleIcon } from "@phosphor-icons/react";

import { IconButton } from "../primitives";

// Hide (inside the sidebar) and Show (in a header once it is collapsed) are
// the same control, so every view renders this one.
export function SidebarToggleButton({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }): JSX.Element {
  return (
    <IconButton
      label={expanded ? "Hide sidebar" : "Show sidebar"}
      icon={SidebarSimpleIcon}
      aria-controls="app-sidebar"
      aria-expanded={expanded}
      data-testid={expanded ? "sidebar-collapse-toggle" : "sidebar-expand-toggle"}
      onClick={onToggle}
    />
  );
}

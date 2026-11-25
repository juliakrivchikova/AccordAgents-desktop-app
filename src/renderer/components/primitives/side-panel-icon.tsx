import { SidebarSimpleIcon, type IconProps } from "@phosphor-icons/react";

// Phosphor draws the bar on the left; the side panel opens on the right.
export const SidePanelIcon = (props: IconProps) => <SidebarSimpleIcon mirrored {...props} />;

import type { LucideIcon } from "lucide-react";

import { SegmentedTabs } from "@/renderer/components/segmented-tabs";

export interface ViewTabItem<TValue extends string> {
  value: TValue;
  label: string;
  icon?: LucideIcon;
}

export interface ViewTabsProps<TValue extends string> {
  value: TValue;
  onChange: (value: TValue) => void;
  items: Array<ViewTabItem<TValue>>;
  ariaLabel?: string;
  className?: string;
}

export const ViewTabs = <TValue extends string>({
  value,
  onChange,
  items,
  ariaLabel = "View tabs",
  className
}: ViewTabsProps<TValue>): JSX.Element => (
  <SegmentedTabs
    value={value}
    items={items}
    ariaLabel={ariaLabel}
    className={className}
    onValueChange={onChange}
  />
);

import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface ViewTabItem<TValue extends string> {
  value: TValue;
  label: string;
  icon?: LucideIcon;
}

export interface ViewTabsProps<TValue extends string> {
  value: TValue;
  onChange: (value: TValue) => void;
  items: Array<ViewTabItem<TValue>>;
  className?: string;
}

export const ViewTabs = <TValue extends string>({
  value,
  onChange,
  items,
  className
}: ViewTabsProps<TValue>): JSX.Element => (
  <Tabs
    value={value}
    onValueChange={(next) => onChange(next as TValue)}
    orientation="horizontal"
    className={className}
  >
    <TabsList>
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <TabsTrigger key={item.value} value={item.value}>
            {Icon ? <Icon aria-hidden /> : null}
            {item.label}
          </TabsTrigger>
        );
      })}
    </TabsList>
  </Tabs>
);

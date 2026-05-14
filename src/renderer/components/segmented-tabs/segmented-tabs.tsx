import type { CSSProperties } from "react";
import type { LucideIcon } from "lucide-react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import "./segmented-tabs.css";

export interface SegmentedTabItem<TValue extends string> {
  value: TValue;
  label: string;
  icon?: LucideIcon;
  testId?: string;
}

export interface SegmentedTabsProps<TValue extends string> {
  value: TValue;
  items: Array<SegmentedTabItem<TValue>>;
  ariaLabel: string;
  onValueChange: (value: TValue) => void;
  className?: string;
  minItemWidth?: number;
}

export function SegmentedTabs<TValue extends string>({
  value,
  items,
  ariaLabel,
  onValueChange,
  className,
  minItemWidth = 120
}: SegmentedTabsProps<TValue>): JSX.Element {
  return (
    <Tabs
      value={value}
      onValueChange={(nextValue) => onValueChange(nextValue as TValue)}
      className={cn("segmented-tabs", className)}
    >
      <TabsList
        variant="line"
        aria-label={ariaLabel}
        className="segmented-tabs__list"
        style={{
          "--segmented-tabs-count": items.length,
          "--segmented-tabs-min-item-width": `${minItemWidth}px`
        } as CSSProperties}
      >
        {items.map((item) => {
          const Icon = item.icon;

          return (
            <TabsTrigger
              key={item.value}
              value={item.value}
              className="segmented-tabs__trigger"
              data-testid={item.testId}
            >
              {Icon ? <Icon aria-hidden /> : null}
              <span>{item.label}</span>
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}

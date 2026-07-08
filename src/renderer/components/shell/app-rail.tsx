import { Bell, MessageSquare, Settings } from "lucide-react";
import type { RailView } from "../../app/app-state";

export interface AppRailProps {
  activeView: RailView;
  activityCount: number;
  onSelect: (view: RailView) => void;
}

const ITEMS: { view: RailView; label: string; icon: typeof MessageSquare }[] = [
  { view: "chats", label: "Chats", icon: MessageSquare },
  { view: "activity", label: "Activity", icon: Bell },
  { view: "settings", label: "Settings", icon: Settings }
];

export function AppRail({ activeView, activityCount, onSelect }: AppRailProps): JSX.Element {
  return (
    <nav className="app-rail" aria-label="Primary" data-shell="rail">
      <div className="app-rail-mark" aria-hidden="true">
        <span className="app-rail-mark-dot app-rail-mark-dot-top" />
        <span className="app-rail-mark-dot app-rail-mark-dot-left" />
        <span className="app-rail-mark-dot app-rail-mark-dot-right" />
      </div>
      <div className="app-rail-items">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const active = activeView === item.view;
          return (
            <button
              key={item.view}
              type="button"
              className="app-rail-button"
              data-active={active ? "true" : undefined}
              aria-label={item.label}
              aria-current={active ? "page" : undefined}
              title={item.label}
              onClick={() => onSelect(item.view)}
            >
              <Icon aria-hidden="true" size={21} strokeWidth={1.9} />
              {item.view === "activity" && activityCount > 0 && (
                <span className="app-rail-badge" aria-label={`${activityCount} activity items`}>
                  {activityCount > 9 ? "9+" : activityCount}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

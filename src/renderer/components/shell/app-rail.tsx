import { Bell, MessageSquare, Settings } from "lucide-react";
import type { RailView } from "../../app/app-state";

export interface AppRailProps {
  activeView: RailView;
  onSelect: (view: RailView) => void;
}

const ITEMS: { view: RailView; label: string; icon: typeof MessageSquare }[] = [
  { view: "chats", label: "Chats", icon: MessageSquare },
  { view: "activity", label: "Activity", icon: Bell }
];

export function AppRail({ activeView, onSelect }: AppRailProps): JSX.Element {
  return (
    <nav className="app-rail" aria-label="Primary" data-shell="rail">
      <div className="app-rail-primary">
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
              <span className="app-rail-icon">
                <Icon aria-hidden="true" size={20} strokeWidth={1.75} />
              </span>
              <span className="app-rail-label">{item.label}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="app-rail-button"
        data-active={activeView === "settings" ? "true" : undefined}
        aria-label="Settings"
        aria-current={activeView === "settings" ? "page" : undefined}
        title="Settings"
        onClick={() => onSelect("settings")}
      >
        <span className="app-rail-icon">
          <Settings aria-hidden="true" size={20} strokeWidth={1.75} />
        </span>
        <span className="app-rail-label">Settings</span>
      </button>
    </nav>
  );
}

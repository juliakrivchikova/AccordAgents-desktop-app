import { isWindowsPlatform } from "../../lib/platform";
import { Switch } from "@/components/ui/switch";

interface BetaUpdatesRowProps {
  enabled: boolean;
  onChange: (enabled: boolean) => Promise<void>;
}

// Betas have no Windows build, so Windows always gets stable updates and has
// nothing to switch.
export const BetaUpdatesRow = ({ enabled, onChange }: BetaUpdatesRowProps) => {
  if (isWindowsPlatform()) {
    return null;
  }
  return (
    <>
      <div className="gen-card-divider" />
      <div className="gen-row">
        <div className="gen-row-text">
          <div className="gen-row-title">Beta updates</div>
          <div className="gen-row-desc">Receive beta releases. Applies on next restart.</div>
        </div>
        <Switch
          data-testid="beta-updates-toggle"
          checked={enabled}
          onChange={(event) => void onChange(event.target.checked)}
        />
      </div>
    </>
  );
};

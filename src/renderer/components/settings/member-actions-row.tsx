import { Switch } from "@/components/ui/switch";

interface MemberActionsRowProps {
  shown: boolean;
  onChange: (shown: boolean) => Promise<void>;
}

// Asked for by a user whose chats grew long with tool lines (the User,
// 2026-11-27). On by default, as each CLI shows them.
export const MemberActionsRow = ({ shown, onChange }: MemberActionsRowProps) => (
  <>
    <div className="gen-card-divider" />
    <div className="gen-row">
      <div className="gen-row-text">
        <div className="gen-row-title">Show members’ actions</div>
        <div className="gen-row-desc">
          List the commands, file edits and other tools members use inside their replies, here and on your phone. Turned off, a reply shows only what its member writes; approvals, questions and errors still show.
        </div>
      </div>
      <Switch
        data-testid="member-actions-toggle"
        aria-label="Show members’ actions"
        checked={shown}
        onChange={(event) => void onChange(event.target.checked)}
      />
    </div>
  </>
);

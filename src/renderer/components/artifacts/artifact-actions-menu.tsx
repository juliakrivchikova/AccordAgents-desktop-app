import type { Ref } from "react";
import { Archive, BadgeCheck, Check, ChevronDown, FileDiff, FileText, Pencil, RotateCcw, UsersRound } from "lucide-react";
import { DropdownMenu } from "radix-ui";

import { ArtifactApprovedMark } from "./artifact-approval-badge";

export type ArtifactMenuAction = "sign" | "rename" | "access" | "archive" | "restore";

export interface ArtifactActionsMenuProps {
  title: string;
  approved: boolean;
  meta: string[];
  view?: { showDiff: boolean; fromVersion: number; onChange: (showDiff: boolean) => void };
  signVersion?: number;
  archived: boolean;
  canRename: boolean;
  canManage: boolean;
  busy: boolean;
  triggerRef?: Ref<HTMLButtonElement>;
  onSign: () => void;
  onRename: () => void;
  onOpenAccess: () => void;
  onArchivedChange: (archived: boolean) => void;
}

// Which actions the title menu offers. Edit and copy stay on the content itself; Sign is
// deliberately in both places — here for discoverability, and as a shortcut on the content
// surface — so the two share one gate in the panel (see menuSignVersion).
export function artifactMenuActions(props: Pick<ArtifactActionsMenuProps, "signVersion" | "canRename" | "canManage" | "archived">): ArtifactMenuAction[] {
  const actions: ArtifactMenuAction[] = [];
  if (props.signVersion !== undefined) {
    actions.push("sign");
  }
  if (props.canRename) {
    actions.push("rename");
  }
  if (props.canManage) {
    actions.push("access", props.archived ? "restore" : "archive");
  }
  return actions;
}

export function ArtifactActionsMenu(props: ArtifactActionsMenuProps): JSX.Element {
  const actions = artifactMenuActions(props);
  const main = actions.filter((action) => action !== "archive" && action !== "restore");
  const lifecycle = actions.filter((action) => action === "archive" || action === "restore");
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          ref={props.triggerRef}
          type="button"
          className="artifact-title-trigger"
          data-testid="artifact-actions-menu"
          title={props.title}
        >
          <span>{props.title}</span>
          {props.approved && <ArtifactApprovedMark />}
          <ChevronDown size={15} aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="artifact-menu" align="start" sideOffset={6} collisionPadding={12}>
          <div className="artifact-menu-meta">
            {props.meta.map((line) => <div key={line}>{line}</div>)}
          </div>
          {props.view && (
            <>
              <DropdownMenu.Separator className="artifact-menu-separator" />
              <DropdownMenu.Label className="artifact-menu-label">View</DropdownMenu.Label>
              <DropdownMenu.RadioGroup
                value={props.view.showDiff ? "changes" : "content"}
                onValueChange={(value) => props.view?.onChange(value === "changes")}
              >
                <DropdownMenu.RadioItem value="content" className="artifact-menu-item" disabled={props.busy}>
                  <FileText aria-hidden />
                  <span className="artifact-menu-item-label">Content</span>
                  <DropdownMenu.ItemIndicator className="artifact-menu-indicator"><Check aria-hidden /></DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
                <DropdownMenu.RadioItem value="changes" className="artifact-menu-item" disabled={props.busy} data-testid="artifact-show-diff-toggle">
                  <FileDiff aria-hidden />
                  <span className="artifact-menu-item-label">Changes since v{props.view.fromVersion}</span>
                  <DropdownMenu.ItemIndicator className="artifact-menu-indicator"><Check aria-hidden /></DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              </DropdownMenu.RadioGroup>
            </>
          )}
          {main.length > 0 && <DropdownMenu.Separator className="artifact-menu-separator" />}
          {main.map((action) => (
            action === "sign" ? (
              <DropdownMenu.Item key={action} className="artifact-menu-item" disabled={props.busy} onSelect={props.onSign}>
                <BadgeCheck aria-hidden /><span className="artifact-menu-item-label">Sign v{props.signVersion}</span>
              </DropdownMenu.Item>
            ) : action === "rename" ? (
              <DropdownMenu.Item key={action} className="artifact-menu-item" disabled={props.busy} onSelect={props.onRename}>
                <Pencil aria-hidden /><span className="artifact-menu-item-label">Rename</span>
              </DropdownMenu.Item>
            ) : (
              <DropdownMenu.Item key={action} className="artifact-menu-item" disabled={props.busy} onSelect={props.onOpenAccess}>
                <UsersRound aria-hidden /><span className="artifact-menu-item-label">Members &amp; access</span>
              </DropdownMenu.Item>
            )
          ))}
          {lifecycle.length > 0 && <DropdownMenu.Separator className="artifact-menu-separator" />}
          {lifecycle.map((action) => (
            <DropdownMenu.Item
              key={action}
              className="artifact-menu-item"
              disabled={props.busy}
              onSelect={() => props.onArchivedChange(action === "archive")}
            >
              {action === "archive" ? <Archive aria-hidden /> : <RotateCcw aria-hidden />}
              <span className="artifact-menu-item-label">{action === "archive" ? "Archive" : "Restore"}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

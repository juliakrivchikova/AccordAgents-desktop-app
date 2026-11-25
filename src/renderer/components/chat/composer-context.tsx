import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { FolderSimpleIcon, GitBranchIcon } from "@phosphor-icons/react";
import type { GitRepoInfo } from "../../../shared/types";
import { cleanIpcError } from "../../lib/ipc-error";
import { ComposerMenu, ComposerMenuItem, ComposerMenuNote, ComposerMenuSection } from "./composer-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { projectLabelForPath } from "../../../shared/newChat";

/**
 * The composer's context strip (the User chose it on 2026-11-22, "B + C"):
 * where the work happens on the left (the folder, the branch), how the main
 * session runs on the right (model, effort, permission mode, where it runs).
 * New chat and the open chat show the same strip in the same place, so the
 * composer does not change when the chat starts.
 */
export const ComposerContextStrip = ({ lead, children }: { lead?: ReactNode; children?: ReactNode }): JSX.Element => (
  <div className="chat-composer-context" data-testid="chat-composer-context">
    {lead && <div className="chat-composer-context-lead">{lead}</div>}
    <span className="chat-composer-context-spacer" />
    {children}
  </div>
);

interface ComposerRepoLeadProps {
  repoPath?: string;
  repo?: GitRepoInfo;
  /** Why the branch cannot be switched now. */
  lockedReason?: string;
  onRepoChange: (repo: GitRepoInfo) => void;
}

/** The folder of an open chat (fixed once the chat exists) and its branch,
 *  which can be switched as in Codex's and Claude's apps. */
export const ComposerRepoLead = ({ repoPath, repo, lockedReason, onRepoChange }: ComposerRepoLeadProps): JSX.Element | null => {
  if (!repoPath) return null;
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="chat-composer-context-item" tabIndex={0} aria-label={`Folder ${repoPath}`}>
            <FolderSimpleIcon size={14} aria-hidden />
            <span className="chat-composer-context-text">{projectLabelForPath(repoPath)}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{repoPath}</TooltipContent>
      </Tooltip>
      <ComposerBranchMenu repo={repo} lockedReason={lockedReason} onRepoChange={onRepoChange} />
    </>
  );
};

interface ComposerBranchMenuProps {
  repo?: GitRepoInfo;
  lockedReason?: string;
  onRepoChange: (repo: GitRepoInfo) => void;
}

/**
 * The folder's branch, switched with `git switch` to one of its own
 * branches. Git refuses when uncommitted changes would be overwritten, and
 * its words are shown; while a chat works in the folder it stays as it is.
 */
export const ComposerBranchMenu = ({ repo, lockedReason, onRepoChange }: ComposerBranchMenuProps): JSX.Element | null => {
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string>();
  if (!repo?.isRepo || (!repo.currentBranch && !repo.localBranches?.length)) return null;
  // Detached (a tag checked out, say): still a way back to a branch.
  const current = repo.currentBranch;
  const label = current ?? "Detached HEAD";
  const branches = repo.localBranches?.length ? repo.localBranches : current ? [current] : [];
  const switchTo = async (branch: string, close: () => void): Promise<void> => {
    if (branch === current) { close(); return; }
    setSwitching(true);
    setError(undefined);
    try {
      onRepoChange(await window.consensus.switchGitBranch({ repoPath: repo.repoPath, branch }));
      close();
    } catch (caught) {
      setError(cleanIpcError(caught));
    } finally {
      setSwitching(false);
    }
  };
  const menu = (
    <ComposerMenu
      testId="chat-composer-branch"
      title={`Branch ${label}`}
      width={280}
      align="start"
      disabled={Boolean(lockedReason)}
      triggerClassName="chat-composer-context-item is-quiet is-menu"
      label={(
        <>
          <GitBranchIcon size={14} aria-hidden />
          <span className="chat-composer-context-text">{label}</span>
        </>
      )}
    >
      {(close) => (
        <>
          <RefreshOnOpen repoPath={repo.repoPath} onRepoChange={onRepoChange} />
          <ComposerMenuSection label="Switch the folder to">
            {branches.map((branch) => (
              <ComposerMenuItem key={branch} testId="chat-composer-branch-option" value={branch} label={branch}
                selected={branch === current} disabled={switching} onSelect={() => void switchTo(branch, close)} />
            ))}
          </ComposerMenuSection>
          {error && <ComposerMenuNote testId="chat-composer-branch-error"><span className="text-ui-danger" role="alert">{error}</span></ComposerMenuNote>}
          <ComposerMenuNote>Every chat in this folder works on the branch it is on.</ComposerMenuNote>
        </>
      )}
    </ComposerMenu>
  );
  if (!lockedReason) return menu;
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className="inline-flex">{menu}</span></TooltipTrigger>
      <TooltipContent side="top">{lockedReason}</TooltipContent>
    </Tooltip>
  );
};

/** Reads the folder again as its menu opens: a switch made elsewhere (in the
 *  terminal, say) shows before a branch is chosen. */
const RefreshOnOpen = ({ repoPath, onRepoChange }: { repoPath: string; onRepoChange: (repo: GitRepoInfo) => void }): null => {
  useEffect(() => {
    let current = true;
    void window.consensus.inspectRepo(repoPath).then((info) => { if (current) onRepoChange(info); }).catch(() => undefined);
    return () => { current = false; };
    // Once per opening; a new callback each render must not read it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath]);
  return null;
};

/** A folder as git sees it (its branch and branches), read once per folder,
 *  with what a switch returns put in its place. */
export function useRepoInfo(repoPath: string | undefined): [GitRepoInfo | undefined, (repo: GitRepoInfo) => void] {
  const [repo, setRepo] = useState<GitRepoInfo>();
  useEffect(() => {
    if (!repoPath) return;
    let current = true;
    void window.consensus.inspectRepo(repoPath)
      .then((info) => { if (current) setRepo(info); })
      .catch(() => undefined);
    return () => { current = false; };
  }, [repoPath]);
  return [repo && repo.repoPath === repoPath?.trim() ? repo : undefined, setRepo];
}

/** Where the composer's footer takes Plan mode: the strip's controls render
 *  it there, beside Send, as the User's chosen layout has it. */
export const ComposerFooterSlot = createContext<HTMLElement | null>(null);

export const useComposerFooterSlot = (): HTMLElement | null => useContext(ComposerFooterSlot);

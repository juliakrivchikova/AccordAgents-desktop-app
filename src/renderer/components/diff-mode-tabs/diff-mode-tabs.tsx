import { SegmentedTabs, type SegmentedTabItem } from "@/renderer/components/segmented-tabs";
import type { GitDiffMode } from "../../../shared/types";

const DIFF_MODE_TABS: Array<SegmentedTabItem<GitDiffMode>> = [
  { value: "uncommitted", label: "Uncommitted", testId: "diff-mode-tab-uncommitted" },
  { value: "working", label: "Unstaged", testId: "diff-mode-tab-working" },
  { value: "staged", label: "Staged", testId: "diff-mode-tab-staged" },
  { value: "base", label: "Branches", testId: "diff-mode-tab-base" },
  { value: "commit", label: "Commit", testId: "diff-mode-tab-commit" },
  { value: "pasted", label: "Pasted diff", testId: "diff-mode-tab-pasted" }
];

export interface DiffModeTabsProps {
  value: GitDiffMode;
  onValueChange: (value: GitDiffMode) => void;
}

export function DiffModeTabs({ value, onValueChange }: DiffModeTabsProps): JSX.Element {
  return (
    <SegmentedTabs
      value={value}
      items={DIFF_MODE_TABS}
      ariaLabel="Diff mode"
      minItemWidth={112}
      onValueChange={onValueChange}
    />
  );
}

import type { ComponentType } from "react";
import { CodeIcon, ArrowSquareOutIcon, FolderOpenIcon, QuestionIcon, type IconProps } from "@phosphor-icons/react";

import type { RepoFileOpenAction } from "../../../shared/types";
import { AppSelect, SidePanelIcon } from "../primitives";

// The file-open choices in General settings: what a click on a file link does,
// and what the side panel's Open button does.
export interface FileOpenOption {
  key: "panel" | "open" | "reveal" | "intellij-idea" | "ask";
  value: RepoFileOpenAction | null;
  label: string;
  icon: ComponentType<IconProps>;
}

export const EXTERNAL_OPEN_OPTIONS: FileOpenOption[] = [
  { key: "open", value: "open", label: "Open with default app", icon: ArrowSquareOutIcon },
  { key: "intellij-idea", value: "intellij-idea", label: "Open in IntelliJ IDEA", icon: CodeIcon },
  { key: "ask", value: null, label: "Ask every time", icon: QuestionIcon }
];

export const FILE_OPEN_OPTIONS: FileOpenOption[] = [
  { key: "panel", value: "panel", label: "Open in side panel", icon: SidePanelIcon },
  { key: "open", value: "open", label: "Open with default app", icon: ArrowSquareOutIcon },
  { key: "reveal", value: "reveal", label: "Reveal in file manager", icon: FolderOpenIcon },
  { key: "intellij-idea", value: "intellij-idea", label: "Open in IntelliJ IDEA", icon: CodeIcon },
  { key: "ask", value: null, label: "Ask every time", icon: QuestionIcon }
];

/** The same select as every other settings row, with each choice's icon. */
export function FileOpenDropdown(props: {
  options: FileOpenOption[];
  action: RepoFileOpenAction | null;
  ariaLabel: string;
  onChange: (action: RepoFileOpenAction | null) => Promise<void>;
}): JSX.Element {
  const current = props.options.find((option) => option.value === props.action)
    ?? props.options.find((option) => option.key === "ask")
    ?? props.options[0];
  return (
    <AppSelect
      size="sm"
      value={current.key}
      placeholder={current.label}
      ariaLabel={props.ariaLabel}
      options={props.options.map(({ key, label, icon: Icon }) => ({ value: key, label, icon: <Icon size={14} /> }))}
      onValueChange={(key) => {
        const chosen = props.options.find((option) => option.key === key);
        if (chosen) void props.onChange(chosen.value);
      }}
    />
  );
}

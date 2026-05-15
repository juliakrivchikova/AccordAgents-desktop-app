import { GitPullRequest, ListChecks, MessageSquare, Users, type LucideIcon } from "lucide-react";

import { SegmentedTabs } from "@/renderer/components/segmented-tabs";
import type { ConversationKind } from "../../../shared/types";

interface SessionModeTab {
  value: ConversationKind;
  label: string;
  icon: LucideIcon;
}

const SESSION_MODE_TABS: SessionModeTab[] = [
  { value: "code-review", label: "Code review", icon: GitPullRequest },
  { value: "general", label: "Question", icon: MessageSquare },
  { value: "implementation-plan", label: "Plan", icon: ListChecks },
  { value: "chat", label: "Chat", icon: Users }
];

export interface SessionModeTabsProps {
  value: ConversationKind;
  onValueChange: (value: ConversationKind) => void;
}

export function SessionModeTabs({ value, onValueChange }: SessionModeTabsProps): JSX.Element {
  return (
    <SegmentedTabs
      value={value}
      items={SESSION_MODE_TABS.map((item) => ({
        ...item,
        testId: `session-mode-tab-${item.value}`
      }))}
      ariaLabel="Session mode"
      className="session-mode-tabs"
      minItemWidth={128}
      onValueChange={onValueChange}
    />
  );
}

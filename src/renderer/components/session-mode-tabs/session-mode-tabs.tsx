import { GitPullRequest, ListChecks, MessageSquare, Users, type LucideIcon } from "lucide-react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ConversationKind } from "../../../shared/types";
import "./session-mode-tabs.css";

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
    <Tabs
      value={value}
      onValueChange={(nextValue) => onValueChange(nextValue as ConversationKind)}
      className="session-mode-tabs"
    >
      <TabsList variant="line" aria-label="Session mode" className="session-mode-tabs__list">
        {SESSION_MODE_TABS.map((item) => {
          const Icon = item.icon;

          return (
            <TabsTrigger
              key={item.value}
              value={item.value}
              className="session-mode-tabs__trigger"
              data-testid={`session-mode-tab-${item.value}`}
            >
              <Icon aria-hidden />
              <span>{item.label}</span>
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}

// How a new chat starts (Settings → General): the CLI its main session runs
// on and the view it opens in (docs/main-session.md). The provider setting is
// the one the Chat Assistant used; it now names the main session's CLI.
import { Fragment } from "react";

import type { AgentHealth, ChatProviderKind, ChatViewMode, ProviderSettings } from "../../../shared/types";
import { cliProviderMetadata, deriveAgentReadiness } from "../../../shared/cliReadiness";
import { isChatProviderKind } from "../../../shared/chatProviders";
import { DEFAULT_CHAT_VIEW, isChatViewMode } from "../../../shared/mainSession";
import { AppSelect } from "../primitives";

const SELECT_CLASS_NAME = "assistant-provider-select min-h-7 data-[size=sm]:rounded-[10px] border-[var(--app-hairline)] bg-[var(--app-surface)] text-[14px] dark:bg-[var(--app-surface)]";

const CHAT_VIEW_OPTIONS: Array<{ value: ChatViewMode; label: string }> = [
  { value: "sessions", label: "Sessions" },
  { value: "classic", label: "Classic" }
];

export function providerDisplayLabel(provider: Pick<ProviderSettings, "kind" | "label">): string {
  return isChatProviderKind(provider.kind) ? cliProviderMetadata(provider.kind).label : provider.label;
}

export function NewChatDefaultsRows(props: {
  providers: ProviderSettings[];
  agents: AgentHealth[];
  assistantProviderKind?: ChatProviderKind;
  defaultChatView?: ChatViewMode;
  setAssistantProviderKind: (kind: ChatProviderKind) => Promise<void>;
  setDefaultChatView: (view: ChatViewMode) => Promise<void>;
}): JSX.Element {
  return (
    <Fragment>
      <div className="gen-row">
        <div className="gen-row-text">
          <div className="gen-row-title">Default provider for new chats</div>
          <div className="gen-row-desc">The CLI a new chat starts on.</div>
        </div>
        <AppSelect
          value={props.assistantProviderKind ?? ""}
          options={props.providers.filter((provider) => isChatProviderKind(provider.kind)).map((provider) => {
            const readiness = deriveAgentReadiness(
              props.agents.find((agent) => agent.kind === provider.kind),
              provider.enabled
            );
            const displayLabel = providerDisplayLabel(provider);
            return {
              value: provider.kind,
              label: readiness === "ready" ? displayLabel : `${displayLabel} (not ready)`,
              disabled: readiness !== "ready"
            };
          })}
          placeholder="Choose provider"
          ariaLabel="Default provider for new chats"
          testId="assistant-provider-select"
          size="sm"
          className={SELECT_CLASS_NAME}
          onValueChange={(value) => {
            if (isChatProviderKind(value)) {
              void props.setAssistantProviderKind(value);
            }
          }}
        />
      </div>
      <div className="gen-card-divider" />
      <div className="gen-row">
        <div className="gen-row-text">
          <div className="gen-row-title">Default view for new chats</div>
          <div className="gen-row-desc">How a new chat opens. Each chat can switch its view in its header.</div>
        </div>
        <AppSelect
          value={isChatViewMode(props.defaultChatView) ? props.defaultChatView : DEFAULT_CHAT_VIEW}
          options={CHAT_VIEW_OPTIONS}
          placeholder="Choose view"
          ariaLabel="Default view for new chats"
          testId="default-chat-view-select"
          size="sm"
          className={SELECT_CLASS_NAME}
          onValueChange={(value) => {
            if (isChatViewMode(value)) {
              void props.setDefaultChatView(value);
            }
          }}
        />
      </div>
    </Fragment>
  );
}

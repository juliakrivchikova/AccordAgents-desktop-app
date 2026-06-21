import { useEffect, useMemo, useState } from "react";
import type React from "react";
import { Check, ChevronDown, ShieldCheck } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { effectiveChatAgentPermissionsForProvider, normalizeChatAgentMode, normalizeChatAgentPermissions } from "../../../shared/agentPermissions";
import type {
  ChatAgentPermissions,
  ChatProviderKind,
  ChatRosterChangeParticipantInput,
  ProviderModelCatalog
} from "../../../shared/types";
import { Avatar } from "../avatar/avatar";
import { avatarForChatAvatarOption, avatarForChatParticipant, chatAvatarOptionsForKind, normalizedChatAvatarId } from "./chat-avatars";
import { chatInheritedCliSettingLabel } from "./chat-participant-drafts";

export function ChatParticipantSpecRow(props: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="chat-app-tool-review-spec-row">
      <span>{props.label}</span>
      {props.children}
    </div>
  );
}

export function ChatParticipantAvatarField(props: {
  kind: ChatProviderKind;
  handle: string;
  avatarId?: string;
  onSelect: (avatarId: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const currentId = normalizedChatAvatarId(props.kind, props.avatarId, props.handle);
  const options = chatAvatarOptionsForKind(props.kind);
  const spec = avatarForChatParticipant(
    { id: props.handle, handle: props.handle, kind: props.kind, avatarId: props.avatarId },
    props.handle
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="chat-app-tool-inline-avatar" aria-label="Change avatar">
          <Avatar className="chat-app-tool-review-avatar" spec={spec} />
          <span className="chat-app-tool-inline-avatar-badge" aria-hidden>
            <ChevronDown size={11} />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="chat-app-tool-avatar-menu">
        <div className="chat-app-tool-avatar-grid" role="radiogroup" aria-label="Participant avatar">
          {options.map((option) => {
            const selected = option.id === currentId;
            return (
              <button
                type="button"
                key={option.id}
                className={`chat-app-tool-avatar-choice ${selected ? "selected" : ""}`}
                aria-pressed={selected}
                title={option.label}
                onClick={() => {
                  props.onSelect(option.id);
                  setOpen(false);
                }}
              >
                <Avatar className="chat-app-tool-avatar-choice-img" spec={avatarForChatAvatarOption(option)} />
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function ChatParticipantInlineSelectRow(props: {
  label: string;
  value: string;
  current: string;
  options: { value: string; label: string }[];
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyLabel?: string;
  onSelect: (value: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions = useMemo(() => {
    if (!props.searchable || !normalizedQuery) {
      return props.options;
    }
    return props.options.filter((option) => option.label.toLowerCase().includes(normalizedQuery));
  }, [normalizedQuery, props.options, props.searchable]);
  const contentClassName = props.searchable
    ? "chat-app-tool-inline-menu is-searchable"
    : "chat-app-tool-inline-menu";
  const optionsContent = visibleOptions.length > 0 ? (
    visibleOptions.map((option) => (
      <button
        type="button"
        key={option.value || "__default__"}
        className={`chat-app-tool-inline-option ${option.value === props.current ? "selected" : ""}`}
        onClick={() => {
          props.onSelect(option.value);
          setOpen(false);
          setQuery("");
        }}
      >
        <span>{option.label}</span>
        {option.value === props.current && <Check size={14} aria-hidden />}
      </button>
    ))
  ) : (
    <span className="chat-app-tool-inline-empty">{props.emptyLabel ?? "No options found"}</span>
  );
  const usePersistentScrollArea = props.searchable && visibleOptions.length > 7;
  function scrollPersistentOptions(event: React.WheelEvent<HTMLDivElement>): void {
    const viewport = event.currentTarget.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']");
    if (!viewport) {
      return;
    }
    const deltaY = event.deltaMode === 1
      ? event.deltaY * 16
      : event.deltaMode === 2
        ? event.deltaY * viewport.clientHeight
        : event.deltaY;
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const nextScrollTop = Math.max(0, Math.min(maxScrollTop, viewport.scrollTop + deltaY));
    if (nextScrollTop === viewport.scrollTop) {
      return;
    }
    viewport.scrollTop = nextScrollTop;
    event.stopPropagation();
  }

  return (
    <ChatParticipantSpecRow label={props.label}>
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            setQuery("");
          }
        }}
      >
        <PopoverTrigger asChild>
          <button type="button" className="chat-app-tool-inline-edit" aria-label={`Change ${props.label.toLowerCase()}`}>
            <span>{props.value}</span>
            <ChevronDown size={14} aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={6} className={contentClassName}>
          {props.searchable && (
            <div className="chat-app-tool-inline-search">
              <input
                value={query}
                autoFocus
                aria-label={`Filter ${props.label.toLowerCase()}`}
                placeholder={props.searchPlaceholder ?? `Filter ${props.label.toLowerCase()}`}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </div>
          )}
          {usePersistentScrollArea ? (
            <ScrollArea type="always" className="chat-app-tool-inline-options-scroll" onWheelCapture={scrollPersistentOptions}>
              <div className="chat-app-tool-inline-options">{optionsContent}</div>
            </ScrollArea>
          ) : (
            <div className="chat-app-tool-inline-options">{optionsContent}</div>
          )}
        </PopoverContent>
      </Popover>
    </ChatParticipantSpecRow>
  );
}

export function ChatParticipantInlineModelRow(props: {
  kind: ChatProviderKind;
  model?: string;
  onSelect: (model: string | undefined) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<ProviderModelCatalog | undefined>();
  const [manual, setManual] = useState("");
  const value = props.model?.trim() || undefined;

  useEffect(() => {
    let cancelled = false;
    void window.consensus
      .listProviderModels(props.kind)
      .then((next) => {
        if (!cancelled) {
          setCatalog(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCatalog(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.kind]);

  const models = catalog?.models ?? [];
  const inheritedLabel = chatInheritedCliSettingLabel(props.kind);

  return (
    <ChatParticipantSpecRow label="Model">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) {
            setManual(value ?? "");
          }
        }}
      >
        <PopoverTrigger asChild>
          <button type="button" className="chat-app-tool-inline-edit" aria-label="Change model">
            <span>{value ?? inheritedLabel}</span>
            <ChevronDown size={14} aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={6} className="chat-app-tool-inline-menu">
          <button
            type="button"
            className={`chat-app-tool-inline-option ${!value ? "selected" : ""}`}
            onClick={() => {
              props.onSelect(undefined);
              setOpen(false);
            }}
          >
            <span>{inheritedLabel}</span>
            {!value && <Check size={14} aria-hidden />}
          </button>
          {models.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`chat-app-tool-inline-option ${item.id === value ? "selected" : ""}`}
              onClick={() => {
                props.onSelect(item.id);
                setOpen(false);
              }}
            >
              <span>{item.label}</span>
              {item.id === value && <Check size={14} aria-hidden />}
            </button>
          ))}
          <form
            className="chat-app-tool-inline-manual"
            onSubmit={(event) => {
              event.preventDefault();
              props.onSelect(manual.trim() || undefined);
              setOpen(false);
            }}
          >
            <input value={manual} placeholder="Custom model id" spellCheck={false} onChange={(event) => setManual(event.currentTarget.value)} />
            <button type="submit">Set</button>
          </form>
        </PopoverContent>
      </Popover>
    </ChatParticipantSpecRow>
  );
}

export function ChatParticipantInlinePermissionsRow(props: {
  participant: ChatRosterChangeParticipantInput;
  onChange: (permissions: ChatAgentPermissions) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const permissions = normalizeChatAgentPermissions(props.participant.permissions);
  const labels = participantPermissionSummaryLabels(props.participant);
  const toggles: { key: string; label: string; checked: boolean; next: (value: boolean) => ChatAgentPermissions }[] = [
    { key: "repoRead", label: "Read repo", checked: permissions.repoRead, next: (value) => ({ ...permissions, repoRead: value }) },
    { key: "workspaceWrite", label: "Edit files", checked: permissions.workspaceWrite, next: (value) => ({ ...permissions, workspaceWrite: value }) },
    { key: "webAccess", label: "Web access", checked: permissions.webAccess, next: (value) => ({ ...permissions, webAccess: value }) },
    { key: "shell", label: "Run shell", checked: permissions.shell.enabled, next: (value) => ({ ...permissions, shell: { ...permissions.shell, enabled: value } }) }
  ];
  return (
    <ChatParticipantSpecRow label="Permissions">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="chat-app-tool-inline-edit is-permissions" aria-label="Change permissions">
            <span className="chat-app-tool-review-grants">
              {labels.map((label) => (
                <span className="chat-app-tool-roster-grant" key={label}>
                  <ShieldCheck size={12} aria-hidden />
                  {label}
                </span>
              ))}
            </span>
            <ChevronDown size={14} aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={6} className="chat-app-tool-inline-menu">
          {toggles.map((toggle) => (
            <label className="chat-app-tool-inline-check" key={toggle.key}>
              <input
                type="checkbox"
                checked={toggle.checked}
                onChange={(event) => props.onChange(toggle.next(event.currentTarget.checked))}
              />
              <span>{toggle.label}</span>
            </label>
          ))}
        </PopoverContent>
      </Popover>
    </ChatParticipantSpecRow>
  );
}

export function rosterPermissionGrantLabels(participant: ChatRosterChangeParticipantInput): string[] {
  const permissions = effectiveChatAgentPermissionsForProvider(
    participant.kind,
    normalizeChatAgentMode(participant.agentMode),
    normalizeChatAgentPermissions(participant.permissions)
  );
  const labels: string[] = [];
  if (permissions.repoRead) {
    labels.push("repo read");
  }
  if (permissions.workspaceWrite) {
    labels.push("file editing");
  }
  if (permissions.webAccess) {
    labels.push("web access");
  }
  if (permissions.shell.enabled) {
    labels.push(permissions.shell.rules.length > 0 ? "shell rules" : "shell access");
  }
  const claudeToolCount = permissions.providerNative?.["claude-code"]?.allowedTools.length ?? 0;
  if (claudeToolCount > 0) {
    labels.push(claudeToolCount === 1 ? "Claude tool" : `${claudeToolCount} Claude tools`);
  }
  return labels;
}

export function participantPermissionSummaryLabels(participant: ChatRosterChangeParticipantInput): string[] {
  const labels = rosterPermissionGrantLabels(participant);
  return labels.length > 0 ? labels : ["No extra permissions"];
}

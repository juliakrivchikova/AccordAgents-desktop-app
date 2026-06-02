import { useEffect, useState } from "react";
import { CheckCircle2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type {
  AgentHealth,
  AppSettings,
  ChatParticipantConfig,
  ChatParticipantConfigUpdate,
  ChatRoleConfig,
  ChatRoleConfigUpdate,
  ProviderKind,
  ProviderSettings
} from "../../../shared/types";
import { Avatar } from "../avatar/avatar";
import { avatarForChatAvatarOption } from "../chat/chat-avatars";
import { chatRoleLabel } from "../chat/chat-conversation-data";
import { ChatParticipantDraftRow } from "../chat/chat-participant-draft-row";
import type { ChatParticipantDraft } from "../chat/chat-participant-drafts";
import {
  chatParticipantConfigToDraft,
  defaultChatParticipantDraft,
  normalizedChatDrafts,
  sameParticipantDraft,
  validateChatCliAgents,
  validateChatParticipantDrafts
} from "../chat/chat-participant-drafts";
import { FormRow, IconButton, ResizableTextarea } from "../primitives";

export type SettingsSection = "local-clis" | "roles" | "participants";

export function SettingsView(props: {
  section: SettingsSection;
  settings: AppSettings;
  agents: AgentHealth[];
  updateProvider: (provider: ProviderSettings, patch: { enabled?: boolean }) => Promise<void>;
  saveChatRoleConfig: (update: ChatRoleConfigUpdate) => Promise<void>;
  saveChatParticipantConfig: (update: ChatParticipantConfigUpdate) => Promise<void>;
  deleteChatParticipantConfig: (id: string) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const title = props.section === "local-clis" ? "Local CLIs" : props.section === "roles" ? "Roles" : "Participants";
  const cliProviders = props.settings.providers.filter((provider) => isCli(provider.kind));
  return (
    <section className="settings-view">
      <div className="settings-view-inner">
        <div className="settings-view-head">
          <h1>{title}</h1>
          <IconButton
            size="sm"
            icon={X}
            label="Close settings"
            tooltip="Close settings"
            variant="outline"
            onClick={props.onClose}
          />
        </div>
        {props.section === "roles" && (
          <section className="settings-section">
            <div className="settings-section-head">
              <h2>Chat roles</h2>
              <span>{props.settings.chatRoleConfigs.length} roles</span>
            </div>
            <div className="role-config-list">
              {props.settings.chatRoleConfigs.map((role) => (
                <ChatRoleEditor role={role} onSave={props.saveChatRoleConfig} key={role.id} />
              ))}
              <ChatRoleEditor onSave={props.saveChatRoleConfig} key={`new-role-${props.settings.chatRoleConfigs.length}`} />
            </div>
          </section>
        )}
        {props.section === "participants" && (
          <ParticipantSettingsSection
            settings={props.settings}
            agents={props.agents}
            onSave={props.saveChatParticipantConfig}
            onDelete={props.deleteChatParticipantConfig}
          />
        )}
        {props.section === "local-clis" && (
          <section className="settings-section">
            <div className="settings-section-head">
              <h2>Local CLI setup</h2>
              <span>{cliProviders.length} CLIs</span>
            </div>
            <div className="settings-grid">
              {cliProviders.map((provider) => {
                const health = props.agents.find((agent) => agent.kind === provider.kind);
                return (
                  <div className="settings-item" key={provider.kind}>
                    <div className="settings-item-head">
                      <div>
                        <strong>{provider.label}</strong>
                        <small>{healthLine(health)}</small>
                      </div>
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={provider.enabled}
                          onChange={(event) => void props.updateProvider(provider, { enabled: event.target.checked })}
                        />
                        <span />
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </section>
  );
}

function ParticipantSettingsSection(props: {
  settings: AppSettings;
  agents: AgentHealth[];
  onSave: (update: ChatParticipantConfigUpdate) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}): JSX.Element {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h2>Chat participants</h2>
        <span>{props.settings.chatParticipantConfigs.length} saved</span>
      </div>
      <div className="role-config-list">
        {props.settings.chatParticipantConfigs.map((participant) => (
          <ChatParticipantConfigEditor
            participant={participant}
            settings={props.settings}
            agents={props.agents}
            onSave={props.onSave}
            onDelete={props.onDelete}
            key={participant.id}
          />
        ))}
        <ChatParticipantConfigEditor
          settings={props.settings}
          agents={props.agents}
          onSave={props.onSave}
          onDelete={props.onDelete}
          key={`new-participant-${props.settings.chatParticipantConfigs.length}`}
        />
      </div>
    </section>
  );
}

function ChatParticipantConfigEditor(props: {
  participant?: ChatParticipantConfig;
  settings: AppSettings;
  agents: AgentHealth[];
  onSave: (update: ChatParticipantConfigUpdate) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}): JSX.Element {
  const existingHandles = new Set(
    props.settings.chatParticipantConfigs
      .filter((participant) => participant.id !== props.participant?.id)
      .map((participant) => participant.handle.toLowerCase())
  );
  const [draft, setDraft] = useState<ChatParticipantDraft>(
    props.participant ? chatParticipantConfigToDraft(props.participant) : defaultChatParticipantDraft(props.settings, existingHandles)
  );
  const normalized = normalizedChatDrafts([draft])[0];
  const changed = !props.participant || !sameParticipantDraft(normalized, props.participant);
  const validation = validateChatParticipantDrafts([draft], props.settings.chatRoleConfigs, existingHandles) ?? validateChatCliAgents([normalized], props.agents);
  const canSave = changed && !validation;

  useEffect(() => {
    setDraft(props.participant ? chatParticipantConfigToDraft(props.participant) : defaultChatParticipantDraft(props.settings, existingHandles));
  }, [props.participant, props.settings]);

  return (
    <article className="role-config-card participant-config-card">
      <div className="settings-item-head">
        <div>
          <strong>{props.participant ? `@${props.participant.handle}` : "New participant"}</strong>
          <small>{props.participant ? chatRoleLabel(props.settings.chatRoleConfigs, props.participant) : "saved chat template"}</small>
        </div>
        <div className="settings-item-actions">
          {props.participant && (
            <ConfirmDeleteButton
              label="Delete"
              title={`Delete @${props.participant.handle}?`}
              description="This participant will be removed from saved chat participants and unselected from chats that use it."
              confirmLabel="Delete participant"
              onConfirm={() => props.onDelete(props.participant!.id)}
            />
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={!canSave}
            onClick={() => void props.onSave({ id: props.participant?.id, ...normalized })}
          >
            <CheckCircle2 size={16} />
            Save
          </Button>
        </div>
      </div>
      <ChatParticipantDraftRow
        draft={draft}
        settings={props.settings}
        agents={props.agents}
        renderAvatarOption={(option) => <Avatar className="avatar-choice-preview" spec={avatarForChatAvatarOption(option)} />}
        onChange={setDraft}
      />
      {validation && <div className="inline-error">{validation}</div>}
    </article>
  );
}

function ConfirmDeleteButton(props: {
  label: string;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => Promise<void>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const confirm = async (): Promise<void> => {
    setPending(true);
    try {
      await props.onConfirm();
      setOpen(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="destructive" size="sm">
          <X size={16} />
          {props.label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" size="sm" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="destructive" size="sm" disabled={pending} onClick={() => void confirm()}>
            <X size={16} />
            {pending ? "Deleting..." : props.confirmLabel ?? props.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChatRoleEditor({ role, onSave }: {
  role?: ChatRoleConfig;
  onSave: (update: ChatRoleConfigUpdate) => Promise<void>;
}): JSX.Element {
  const [label, setLabel] = useState(role?.label ?? "");
  const [instructions, setInstructions] = useState(role?.instructions ?? "");
  const changed = label.trim() !== (role?.label ?? "") || instructions.trim() !== (role?.instructions ?? "");
  const canSave = Boolean(label.trim() && instructions.trim()) && (!role || changed);
  return (
    <article className="role-config-card">
      <div className="settings-item-head">
        <div>
          <strong>{role ? role.label : "New role"}</strong>
          <small>{role ? `v${role.version}${role.builtIn ? " built-in" : ""}` : "custom"}</small>
        </div>
        <Button variant="outline" size="sm" disabled={!canSave} onClick={() => void onSave({ id: role?.id, label, instructions })}>
          <CheckCircle2 size={16} />
          Save
        </Button>
      </div>
      <FormRow label="Name">
        <Input value={label} onChange={(event) => setLabel(event.target.value)} />
      </FormRow>
      <FormRow label="Instructions">
        <ResizableTextarea
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          rows={4}
          maxHeight={320}
        />
      </FormRow>
    </article>
  );
}

function isCli(kind: ProviderKind): boolean {
  return kind === "codex-cli" || kind === "claude-code";
}

function healthLine(health: AgentHealth | undefined): string {
  if (!health) {
    return "Not checked";
  }
  if (!health.installed) {
    return "Not installed";
  }
  const base = health.version || health.path || "Installed";
  const skillSync = appSkillSyncLine(health.appSkillSync);
  return skillSync ? `${base} · ${skillSync}` : base;
}

function appSkillSyncLine(sync: AgentHealth["appSkillSync"]): string | undefined {
  if (!sync || sync.status === "not-installed") {
    return undefined;
  }
  if (sync.status === "synced") {
    return sync.skillCount === 1 ? "1 app skill synced" : `${sync.skillCount} app skills synced`;
  }
  if (sync.status === "skipped") {
    return sync.skillCount === 1 ? "1 app skill current" : `${sync.skillCount} app skills current`;
  }
  if (sync.status === "collision") {
    return sync.message ?? "App skill collision";
  }
  return sync.message ?? "App skill sync failed";
}

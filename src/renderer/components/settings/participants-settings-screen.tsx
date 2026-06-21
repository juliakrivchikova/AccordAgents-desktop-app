import { useMemo, useState } from "react";
import { ChevronRight, Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { AgentHealth, AppSettings, ChatParticipantConfigUpdate } from "../../../shared/types";
import { AvatarStack, ParticipantPresetCard } from "./participant-preset-card";
import { ParticipantEditorDialog } from "./participant-editor-dialog";
import { participantMatchesQuery, participantRoleGroups, providerSummary, type ParticipantEditorState } from "./participant-settings-utils";

export function ParticipantsSettingsScreen(props: {
  settings: AppSettings;
  agents: AgentHealth[];
  onSave: (update: ChatParticipantConfigUpdate) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [expandedRoles, setExpandedRoles] = useState<Set<string>>(() => new Set());
  const [editor, setEditor] = useState<ParticipantEditorState | undefined>();
  const groups = useMemo(() => participantRoleGroups(props.settings), [props.settings]);
  const totalCount = props.settings.chatParticipantConfigs.length;
  const normalizedQuery = query.trim().toLowerCase();
  const filteredGroups = useMemo(() => {
    if (!normalizedQuery) {
      return groups;
    }
    return groups
      .map((group) => ({
        ...group,
        participants: group.participants.filter((participant) =>
          participantMatchesQuery(participant, group.label, normalizedQuery)
        )
      }))
      .filter((group) => group.participants.length > 0);
  }, [groups, normalizedQuery]);
  const visibleCount = filteredGroups.reduce((total, group) => total + group.participants.length, 0);

  function toggleRole(id: string): void {
    setExpandedRoles((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <section className="participants-settings-screen" data-testid="settings-participants-screen">
      <div className="participants-settings-toolbar">
        <div className="participants-search">
          <Search size={16} aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search participants"
            aria-label="Search participants"
            spellCheck={false}
          />
        </div>
        <span className="participants-toolbar-count">
          {visibleCount === totalCount ? `${totalCount}` : `${visibleCount} of ${totalCount}`}
        </span>
        <span className="participants-toolbar-spacer" />
        <Button className="participants-settings-new-button" size="lg" onClick={() => setEditor({ type: "new" })}>
          <Plus size={16} aria-hidden />
          New Participant
        </Button>
      </div>

      {filteredGroups.length === 0 ? (
        normalizedQuery ? (
          <div className="participants-empty-state participants-empty-state-search">
            No participants match your search.
          </div>
        ) : (
          <div className="participants-empty-state">
            <strong>No saved participants</strong>
            <span>Create a participant preset to reuse it across chats.</span>
          </div>
        )
      ) : (
        <div className="participants-role-accordion">
          {filteredGroups.map((group) => {
            const open = Boolean(normalizedQuery) || expandedRoles.has(group.id);
            return (
              <div className={`participants-role-row ${open ? "open" : ""}`} key={group.id}>
                <button
                  type="button"
                  className="participants-role-row-head"
                  aria-expanded={open}
                  onClick={() => toggleRole(group.id)}
                >
                  <ChevronRight className="participants-role-chevron" size={17} aria-hidden />
                  <span className="participants-role-row-text">
                    <strong>{group.label}</strong>
                    <small>{providerSummary(group.participants)}</small>
                  </span>
                  <AvatarStack participants={group.participants} max={4} />
                  <span className="participants-role-count">{group.participants.length}</span>
                </button>
                {open && (
                  <div className="participants-role-row-body">
                    <div className="participants-card-grid">
                      {group.participants.map((participant) => (
                        <ParticipantPresetCard
                          participant={participant}
                          settings={props.settings}
                          onOpen={() => setEditor({ type: "edit", participant })}
                          key={participant.id}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ParticipantEditorDialog
        editor={editor}
        settings={props.settings}
        agents={props.agents}
        onSave={props.onSave}
        onDelete={props.onDelete}
        onClose={() => setEditor(undefined)}
      />
    </section>
  );
}


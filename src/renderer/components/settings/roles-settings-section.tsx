import { useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { AppSettings, ChatRoleConfig, ChatRoleConfigUpdate } from "../../../shared/types";
import { ChatRoleEditorDialog } from "./role-editor-dialog";
import { RoleCard } from "./role-card";
import {
  duplicateRoleLabel,
  parseRoleInstructions,
  savedParticipantPresetCountByRole,
  savedParticipantPresetsForRole,
  type RoleEditorState
} from "./role-settings-utils";

type RoleFilter = "all" | "built-in" | "custom";

export function RolesSettingsSection(props: {
  settings: AppSettings;
  onSave: (update: ChatRoleConfigUpdate) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RoleFilter>("all");
  const [editor, setEditor] = useState<RoleEditorState | undefined>();
  // Archived (deleted) roles stay in settings so existing participants keep resolving,
  // but are hidden from the Roles list and the count.
  const roles = props.settings.chatRoleConfigs.filter((role) => !role.archivedAt);
  const savedParticipantPresetsByRole = useMemo(
    () => savedParticipantPresetCountByRole(props.settings.chatParticipantConfigs),
    [props.settings.chatParticipantConfigs]
  );
  const normalizedQuery = query.trim().toLowerCase();
  const filterTabs: Array<{ key: RoleFilter; label: string }> = [
    { key: "all", label: "All" },
    { key: "built-in", label: "Built-in" },
    { key: "custom", label: "Custom" }
  ];
  const visibleRoles = roles
    .filter((role) => {
      if (filter === "built-in" && !role.builtIn) {
        return false;
      }
      if (filter === "custom" && role.builtIn) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      return `${role.label} ${role.id} ${role.instructions}`.toLowerCase().includes(normalizedQuery);
    })
    .slice()
    .sort((left, right) => {
      const usageDelta = (savedParticipantPresetsByRole.get(right.id) ?? 0) - (savedParticipantPresetsByRole.get(left.id) ?? 0);
      return usageDelta || left.label.localeCompare(right.label);
    });

  const duplicateRole = (role: ChatRoleConfig): void => {
    const parts = parseRoleInstructions(role.instructions);
    setEditor({
      type: "new",
      initialLabel: duplicateRoleLabel(role.label, roles),
      initialDescription: parts.description,
      initialInstructions: parts.body,
      initialParticipantDefaults: role.participantDefaults
    });
  };

  return (
    <section className="roles-settings-screen" data-testid="settings-roles-screen">
      <div className="roles-toolbar">
        <label className="roles-search">
          <Search size={16} aria-hidden />
          <input
            data-testid="settings-roles-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search roles"
            aria-label="Search roles"
          />
        </label>
        <span className="roles-count">{roles.length} {roles.length === 1 ? "role" : "roles"}</span>
        <div className="roles-toolbar-spacer" />
        <div className="roles-filter-tabs" aria-label="Role filters">
          {filterTabs.map((tab) => (
            <button
              type="button"
              className={`roles-filter-tab ${filter === tab.key ? "is-selected" : ""}`}
              data-testid={`settings-roles-filter-${tab.key}`}
              onClick={() => setFilter(tab.key)}
              key={tab.key}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <Button
          type="button"
          className="roles-new-button"
          data-testid="settings-roles-new"
          onClick={() => setEditor({ type: "new" })}
        >
          <Plus size={15} aria-hidden />
          New role
        </Button>
      </div>

      {visibleRoles.length === 0 ? (
        <div className="roles-empty-state">
          No roles match your search.
        </div>
      ) : (
        <div className="roles-card-grid">
          {visibleRoles.map((role) => (
            <RoleCard
              role={role}
              savedParticipants={savedParticipantPresetsForRole(props.settings.chatParticipantConfigs, role.id)}
              onOpen={() => setEditor({ type: "edit", roleId: role.id })}
              key={role.id}
            />
          ))}
        </div>
      )}

      <ChatRoleEditorDialog
        editor={editor}
        roles={roles}
        savedParticipantPresetsByRole={savedParticipantPresetsByRole}
        onSave={props.onSave}
        onArchive={props.onArchive}
        onDuplicate={duplicateRole}
        onClose={() => setEditor(undefined)}
      />
    </section>
  );
}

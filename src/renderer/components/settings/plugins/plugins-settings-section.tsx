import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Copy, ListChecks, Plug, RefreshCw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IconButton } from "../../primitives";
import type {
  ChatProviderKind,
  PluginCatalogItem,
  PluginListResult,
  UserSkillListResult,
  UserSkillSummary
} from "../../../../shared/types";

type CatalogTab = "plugins" | "skills";
type ProviderFilter = "all" | ChatProviderKind;

interface CatalogState {
  skills?: UserSkillListResult;
  plugins?: PluginListResult;
  loading: boolean;
  error?: string;
}

export function PluginsSettingsSection(props: {
  repoPath?: string;
  onTryPluginInChat: (plugin: PluginCatalogItem) => void;
  onHeaderActionChange?: (action: ReactNode | undefined) => void;
}): JSX.Element {
  const [activeTab, setActiveTab] = useState<CatalogTab>("plugins");
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>("all");
  const [state, setState] = useState<CatalogState>({ loading: true });
  const [copyStatus, setCopyStatus] = useState<string | undefined>();

  const load = useCallback(async (refreshPlugins: boolean): Promise<void> => {
    setState((current) => ({ ...current, loading: true, error: undefined }));
    try {
      const request = {
        repoPath: props.repoPath?.trim() || undefined,
        limit: 100
      };
      const [skills, plugins] = await Promise.all([
        window.consensus.listUserSkills(request),
        refreshPlugins ? window.consensus.refreshPlugins(request) : window.consensus.listPlugins(request)
      ]);
      setState({ skills, plugins, loading: false });
    } catch (error) {
      setState({
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }, [props.repoPath]);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    props.onHeaderActionChange?.(
      <IconButton
        size="sm"
        icon={RefreshCw}
        label="Refresh plugins and skills"
        tooltip="Refresh"
        variant="ghost"
        disabled={state.loading}
        data-testid="plugins-refresh"
        onClick={() => void load(true)}
      />
    );
    return () => props.onHeaderActionChange?.(undefined);
  }, [load, props.onHeaderActionChange, state.loading]);

  const normalizedSearch = search.trim().toLowerCase();
  const visibleSkills = useMemo(() => {
    return (state.skills?.skills ?? [])
      .filter((skill) => matchesSkill(skill, normalizedSearch, providerFilter))
      .sort((left, right) => left.frontmatterName.localeCompare(right.frontmatterName));
  }, [normalizedSearch, providerFilter, state.skills?.skills]);
  const visiblePlugins = useMemo(() => {
    return (state.plugins?.plugins ?? [])
      .filter((plugin) => matchesPlugin(plugin, normalizedSearch, providerFilter))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }, [normalizedSearch, providerFilter, state.plugins?.plugins]);

  async function copyText(label: string, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus(`${label} copied`);
      window.setTimeout(() => setCopyStatus(undefined), 1600);
    } catch {
      setCopyStatus("Copy failed");
      window.setTimeout(() => setCopyStatus(undefined), 1600);
    }
  }

  const activeCount = activeTab === "plugins" ? visiblePlugins.length : visibleSkills.length;
  return (
    <section className="plugins-settings-screen" data-testid="plugins-settings-section">
      <div className="plugins-settings-toolbar">
        <div className="plugins-tabs" role="tablist" aria-label="Plugin and skill catalog">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "plugins"}
            onClick={() => setActiveTab("plugins")}
          >
            <Plug size={15} aria-hidden />
            Plugins
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "skills"}
            onClick={() => setActiveTab("skills")}
          >
            <ListChecks size={15} aria-hidden />
            Skills
          </button>
        </div>
        <label className="plugins-search" aria-label="Search plugins and skills">
          <Search size={16} aria-hidden />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search"
            data-testid="plugins-search"
          />
        </label>
        <ProviderFilterSwitch value={providerFilter} onChange={setProviderFilter} />
        <span className="plugins-count">{activeCount} shown</span>
      </div>

      <div className="plugins-status-row">
        {state.loading ? (
          <span>Loading local catalog...</span>
        ) : state.error ? (
          <span className="plugins-error">{state.error}</span>
        ) : (
          <span>
            Provider status is local discovery only. Start a new chat after adding skills on disk.
          </span>
        )}
        {copyStatus && <span className="plugins-copy-status">{copyStatus}</span>}
      </div>

      {activeTab === "plugins" ? (
        <PluginCatalog
          plugins={visiblePlugins}
          loading={state.loading}
          diagnostics={state.plugins?.diagnostics.errors ?? []}
          onCopy={copyText}
          onTryPluginInChat={props.onTryPluginInChat}
          showProviderChip={providerFilter === "all"}
        />
      ) : (
        <SkillCatalog
          skills={visibleSkills}
          loading={state.loading}
          onCopy={copyText}
          showProviderMarks={providerFilter === "all"}
        />
      )}
    </section>
  );
}

function ProviderFilterSwitch(props: {
  value: ProviderFilter;
  onChange: (value: ProviderFilter) => void;
}): JSX.Element {
  const options: Array<{ value: ProviderFilter; label: string }> = [
    { value: "all", label: "All" },
    { value: "codex-cli", label: "Codex" },
    { value: "claude-code", label: "Claude" }
  ];
  return (
    <div className="plugins-provider-switch" aria-label="Provider filter">
      {options.map((option) => (
        <button
          type="button"
          aria-pressed={props.value === option.value}
          onClick={() => props.onChange(option.value)}
          key={option.value}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function PluginCatalog(props: {
  plugins: PluginCatalogItem[];
  loading: boolean;
  diagnostics: string[];
  onCopy: (label: string, text: string) => Promise<void>;
  onTryPluginInChat: (plugin: PluginCatalogItem) => void;
  showProviderChip: boolean;
}): JSX.Element {
  const installedPlugins = props.plugins.filter((plugin) => plugin.installedProviderKinds.length > 0);
  const availablePlugins = props.plugins.filter((plugin) => plugin.installedProviderKinds.length === 0);
  if (!props.loading && props.plugins.length === 0) {
    return (
      <div className="plugins-empty-state" data-testid="plugins-empty-state">
        No local plugins match this view.
      </div>
    );
  }
  return (
    <div className="plugins-catalog" data-testid="plugins-catalog">
      {installedPlugins.length > 0 && (
        <section className="plugins-catalog-section" data-testid="plugins-installed-section">
          <div className="plugins-catalog-heading">
            <h2>Installed</h2>
            <span>{installedPlugins.length}</span>
          </div>
          <div className="plugins-card-grid plugins-plugin-list">
            {installedPlugins.map((plugin) => (
              <PluginCard plugin={plugin} onCopy={props.onCopy} onTryInChat={props.onTryPluginInChat} showProviderChip={props.showProviderChip} key={plugin.id} />
            ))}
          </div>
        </section>
      )}
      {availablePlugins.length > 0 && (
        <section className="plugins-catalog-section" data-testid="plugins-available-section">
          <div className="plugins-catalog-heading">
            <h2>Available</h2>
            <span>{availablePlugins.length}</span>
          </div>
          <div className="plugins-card-grid plugins-plugin-list">
            {availablePlugins.map((plugin) => (
              <PluginCard plugin={plugin} onCopy={props.onCopy} onTryInChat={props.onTryPluginInChat} showProviderChip={props.showProviderChip} key={plugin.id} />
            ))}
          </div>
        </section>
      )}
      {props.diagnostics.length > 0 && (
        <div className="plugins-diagnostics">
          {props.diagnostics.slice(0, 4).map((message) => <span key={message}>{message}</span>)}
        </div>
      )}
    </div>
  );
}

function PluginCard(props: {
  plugin: PluginCatalogItem;
  onCopy: (label: string, text: string) => Promise<void>;
  onTryInChat: (plugin: PluginCatalogItem) => void;
  showProviderChip: boolean;
}): JSX.Element {
  const action = pluginAction(props.plugin);
  const className = [
    "plugins-card",
    props.plugin.installedProviderKinds.length > 0 ? "is-installed" : ""
  ].filter(Boolean).join(" ");
  return (
    <article className={className} data-testid="plugin-card">
      <div className="plugins-card-main">
        <PluginIcon plugin={props.plugin} />
        <div className="plugins-card-copy">
          <div className="plugins-card-title-row">
            <h2>{props.plugin.displayName}</h2>
            {props.showProviderChip && <ProviderMark providerKind={props.plugin.providerKind} />}
          </div>
          <p>{props.plugin.description ?? props.plugin.statusMessage ?? "Local plugin manifest"}</p>
        </div>
      </div>
      <div className="plugins-row-actions">
        {action ? (
          <Button type="button" variant="outline" size="sm" onClick={() => props.onTryInChat(props.plugin)}>
            {action.button}
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" disabled>
            Install
          </Button>
        )}
      </div>
    </article>
  );
}

function PluginIcon(props: { plugin: PluginCatalogItem }): JSX.Element {
  const style = props.plugin.brandColor
    ? ({ "--plugin-brand-color": props.plugin.brandColor } as CSSProperties)
    : undefined;
  if (props.plugin.iconUrl) {
    return (
      <span className="plugins-card-icon has-image" style={style}>
        <img src={props.plugin.iconUrl} alt="" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className="plugins-card-icon" style={style}>
      <Plug size={18} aria-hidden />
    </span>
  );
}

function ProviderMark(props: { providerKind: ChatProviderKind }): JSX.Element {
  return (
    <span className={`plugins-provider-mark ${providerClass(props.providerKind)}`} title={providerLabel(props.providerKind)}>
      <span className="plugins-provider-dot" aria-hidden />
      {providerLabel(props.providerKind)}
    </span>
  );
}

function SkillCatalog(props: {
  skills: UserSkillSummary[];
  loading: boolean;
  onCopy: (label: string, text: string) => Promise<void>;
  showProviderMarks: boolean;
}): JSX.Element {
  const grouped = groupSkills(props.skills);
  if (!props.loading && props.skills.length === 0) {
    return (
      <div className="plugins-empty-state" data-testid="skills-empty-state">
        No skills match this view.
      </div>
    );
  }
  return (
    <div className="plugins-catalog" data-testid="skills-catalog">
      {grouped.map((group) => (
        <section className="plugins-catalog-section" data-testid={`skills-${group.id}-section`} key={group.id}>
          <div className="plugins-catalog-heading">
            <h2>{group.title}</h2>
            <span>{group.skills.length}</span>
          </div>
          <div className="plugins-card-grid plugins-skill-list">
            {group.skills.map((skill) => (
              <SkillCard
                skill={skill}
                onCopy={props.onCopy}
                showProviderMarks={props.showProviderMarks}
                key={skill.skillId}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function SkillCard(props: {
  skill: UserSkillSummary;
  onCopy: (label: string, text: string) => Promise<void>;
  showProviderMarks: boolean;
}): JSX.Element {
  return (
    <article className="plugins-card" data-testid="skill-card">
      <div className="plugins-card-main">
        <span className="plugins-card-icon"><ListChecks size={18} aria-hidden /></span>
        <div className="plugins-card-copy">
          <div className="plugins-card-title-row">
            <h2>{props.skill.displayName}</h2>
          </div>
          {props.showProviderMarks && (
            <div className="plugins-skill-provider-row">
              {props.skill.providerKinds.map((providerKind) => (
                <ProviderMark providerKind={providerKind} key={providerKind} />
              ))}
            </div>
          )}
          <p>{props.skill.description ?? props.skill.statusMessage ?? "User skill"}</p>
          <div className="plugins-skill-meta">
            <span>{skillScopeLabel(props.skill)}</span>
            <span>{props.skill.capabilityState === "invocable" ? "Usable from /" : "Discovery only"}</span>
          </div>
        </div>
      </div>
      <div className="plugins-row-actions">
        <Button type="button" variant="outline" size="sm" onClick={() => void props.onCopy(props.skill.displayName, `/${props.skill.frontmatterName}`)}>
          <Copy size={14} aria-hidden />
          Copy
        </Button>
      </div>
    </article>
  );
}

function matchesSkill(skill: UserSkillSummary, query: string, provider: ProviderFilter): boolean {
  const queryMatch = !query ||
    skill.displayName.toLowerCase().includes(query) ||
    skill.frontmatterName.toLowerCase().includes(query) ||
    (skill.description?.toLowerCase().includes(query) ?? false);
  const providerMatch = provider === "all" || skill.providerKinds.includes(provider);
  return queryMatch && providerMatch;
}

function matchesPlugin(plugin: PluginCatalogItem, query: string, provider: ProviderFilter): boolean {
  const queryMatch = !query ||
    plugin.displayName.toLowerCase().includes(query) ||
    plugin.name.toLowerCase().includes(query) ||
    (plugin.description?.toLowerCase().includes(query) ?? false) ||
    (plugin.category?.toLowerCase().includes(query) ?? false);
  const providerMatch = provider === "all" || plugin.providerKind === provider;
  return queryMatch && providerMatch;
}

function groupSkills(skills: UserSkillSummary[]): Array<{ id: "project" | "personal"; title: string; skills: UserSkillSummary[] }> {
  const projectSkills = skills.filter((skill) => skill.scopeKinds.includes("repo"));
  const personalSkills = skills.filter((skill) => !skill.scopeKinds.includes("repo"));
  return [
    { id: "project" as const, title: "Project skills", skills: projectSkills },
    { id: "personal" as const, title: "Personal skills", skills: personalSkills }
  ].filter((group) => group.skills.length > 0);
}

function skillScopeLabel(skill: UserSkillSummary): string {
  return skill.scopeKinds.includes("repo") ? "Project skill" : "Personal skill";
}

function pluginAction(plugin: PluginCatalogItem): { button: string; label: string; text: string } | undefined {
  if (plugin.invocation.kind === "skill-mention") {
    return {
      button: "Try in chat",
      label: plugin.displayName,
      text: `/${plugin.invocation.skill.frontmatterName}`
    };
  }
  if (plugin.invocation.kind === "prompt-insert") {
    return {
      button: "Try in chat",
      label: plugin.displayName,
      text: plugin.invocation.prompt
    };
  }
  if (plugin.invocation.kind === "mcp-passive" && plugin.installedProviderKinds.length > 0) {
    return {
      button: "Try in chat",
      label: plugin.displayName,
      text: `/${plugin.name}`
    };
  }
  return undefined;
}

function providerLabel(providerKind: ChatProviderKind): string {
  return providerKind === "codex-cli" ? "Codex" : providerKind === "gemini-cli" ? "Gemini" : "Claude";
}

function providerClass(providerKind: ChatProviderKind): string {
  return providerKind === "codex-cli" ? "is-codex" : providerKind === "gemini-cli" ? "is-gemini" : "is-claude";
}

import { useContext, useEffect, useRef, useState } from "react";

import type {
  ArtifactSummary,
  ChatParticipant,
  ChatParticipantInput,
  ChatSavedPromptConfig,
  ChatSkillMention,
  PluginCatalogItem,
  RepoFileMention,
  RepoFileSearchResult,
  UserSkillSummary,
  UserSkillTargetSummary
} from "../../../shared/types";
import {
  chatParticipantDisplayName,
  chatParticipantMentionHandle
} from "../conversation/conversation-display";
import { ArtifactsContext } from "../artifacts/artifacts-context";
import {
  activeFileQuery,
  activeMentionQuery,
  activeSkillQuery,
  compactCommandOption,
  goalCommandOption,
  draftHasArtifactMention,
  draftHasFileMention,
  draftHasMention,
  draftHasSkillMention,
  matchArtifactMentions,
  normalizeArtifactDraft,
  removeFileMentionToken,
  removeSkillMentionToken,
  replaceActiveArtifactMention,
  replaceActiveFileMention,
  replaceActiveMention,
  replaceActivePluginMention,
  replaceActiveSkillMention,
  replaceActiveSlashToken,
  type DraftPluginMention
} from "./chat-composer-draft-utils";
import { isSlashInvocablePlugin } from "./chat-plugin-options";
import { chatSlashItems, chatSlashTarget } from "./chat-slash-items";
import type { ChatSlashMenuProps } from "./chat-slash-menu";
import { buildSlashMenu, resolveSlashActive, slashMoreKey, slashNavKey, stepSlashActive, withSlashKind, type SlashKind } from "./slash-menu-model";

const NO_SLASH_KINDS: ReadonlySet<SlashKind> = new Set();
// A failed search still answers, so the menu opens with prompts and no target.
const NO_SLASH_TARGET: UserSkillTargetSummary = { participantIds: [], providerKinds: [], hasClearTargets: false };
// The whole list for the target, filtered here: initials ("/ocgr") and the
// group counts need every skill (main's cap, userSkills.ts MAX_LIMIT).
const SLASH_SEARCH_LIMIT = 500;

export type ChatComposerSearchSource =
  | {
      type: "conversation";
      conversationId?: string;
      repoPath?: string;
    }
  | {
      type: "pre-chat";
      repoPath?: string;
      participants: ChatParticipantInput[];
      assistantProviderKind?: ChatParticipant["kind"];
    };

export function useChatComposerMentions(props: {
  draft: string;
  initialPluginMentions?: DraftPluginMention[];
  initialSkillMentions?: ChatSkillMention[];
  mentionSeedKey?: number;
  searchSource: ChatComposerSearchSource;
  onDraftChange: (value: string) => void;
  onMentionInserted?: (participant: ChatParticipant) => void;
  participants: ChatParticipant[];
  savedPrompts: ChatSavedPromptConfig[];
  selectedFileMentions?: RepoFileMention[];
  selectedPluginMentions?: DraftPluginMention[];
  selectedSkillMentions?: ChatSkillMention[];
  onSelectedFileMentionsChange?: React.Dispatch<React.SetStateAction<RepoFileMention[]>>;
  onSelectedPluginMentionsChange?: React.Dispatch<React.SetStateAction<DraftPluginMention[]>>;
  onSelectedSkillMentionsChange?: React.Dispatch<React.SetStateAction<ChatSkillMention[]>>;
}): {
  fileIndex: number;
  fileOptions: RepoFileSearchResult[];
  insertArtifactMention: (artifact: ArtifactSummary) => void;
  insertCommand: (command: "compact" | "goal") => void;
  insertFileMention: (file: RepoFileSearchResult) => void;
  insertHashOptionAtIndex: (index: number) => void;
  insertMention: (participant: ChatParticipant) => void;
  insertSavedPrompt: (prompt: ChatSavedPromptConfig) => void;
  insertSkillMention: (skill: UserSkillSummary) => void;
  insertPluginMention: (plugin: PluginCatalogItem) => void;
  activateSlashNavAtIndex: (index: number) => void;
  moveSlashActive: (step: number) => void;
  mentionIndex: number;
  mentionOptions: ChatParticipant[];
  pendingCaretRef: React.MutableRefObject<{ value: string; position: number } | undefined>;
  removeFileMention: (filePath: string) => void;
  removeSkillMention: (mention: ChatSkillMention) => void;
  selectedFileMentions: RepoFileMention[];
  selectedPluginMentions: DraftPluginMention[];
  selectedSkillMentions: ChatSkillMention[];
  setFileIndex: React.Dispatch<React.SetStateAction<number>>;
  setFileQuery: React.Dispatch<React.SetStateAction<string | undefined>>;
  setMentionIndex: React.Dispatch<React.SetStateAction<number>>;
  setMentionQuery: React.Dispatch<React.SetStateAction<string | undefined>>;
  setSelectedFileMentions: React.Dispatch<React.SetStateAction<RepoFileMention[]>>;
  setSelectedPluginMentions: React.Dispatch<React.SetStateAction<DraftPluginMention[]>>;
  setSelectedSkillMentions: React.Dispatch<React.SetStateAction<ChatSkillMention[]>>;
  setSkillQuery: React.Dispatch<React.SetStateAction<string | undefined>>;
  showSkillHighlights: boolean;
  skillQuery: string | undefined;
  slashActiveIndex: number;
  /** The open "/" menu; undefined while it is closed. */
  slashMenu?: ChatSlashMenuProps;
  slashNavCount: number;
  /** A "/query" is being typed and the search has not answered yet. */
  slashSearching: boolean;
  updateDraft: (value: string) => void;
  visibleArtifactOptions: ArtifactSummary[];
  visibleFileOptions: RepoFileSearchResult[];
  visibleHashOptionCount: number;
} {
  const [mentionQuery, setMentionQuery] = useState<string | undefined>();
  const [mentionIndex, setMentionIndex] = useState(0);
  const [fileQuery, setFileQuery] = useState<string | undefined>();
  const [fileIndex, setFileIndex] = useState(0);
  const [fileOptions, setFileOptions] = useState<RepoFileSearchResult[]>([]);
  const [skillQuery, setSkillQuery] = useState<string | undefined>();
  // The highlighted slash row by key; undefined puts it on the first insertable row.
  const [slashActiveKey, setSlashActiveKey] = useState<string>();
  const [slashExpanded, setSlashExpanded] = useState(NO_SLASH_KINDS);
  const [skillOptions, setSkillOptions] = useState<UserSkillSummary[]>([]);
  const [pluginOptions, setPluginOptions] = useState<PluginCatalogItem[]>([]);
  const [skillTarget, setSkillTarget] = useState<UserSkillTargetSummary | undefined>();
  const [slashResultKey, setSlashResultKey] = useState<string>();
  const [internalSelectedSkillMentions, setInternalSelectedSkillMentions] = useState<ChatSkillMention[]>([]);
  const [internalSelectedPluginMentions, setInternalSelectedPluginMentions] = useState<DraftPluginMention[]>([]);
  const [internalSelectedFileMentions, setInternalSelectedFileMentions] = useState<RepoFileMention[]>([]);
  const selectedSkillMentions = props.selectedSkillMentions ?? internalSelectedSkillMentions;
  const selectedPluginMentions = props.selectedPluginMentions ?? internalSelectedPluginMentions;
  const selectedFileMentions = props.selectedFileMentions ?? internalSelectedFileMentions;
  const setSelectedSkillMentions = props.onSelectedSkillMentionsChange ?? setInternalSelectedSkillMentions;
  const setSelectedPluginMentions = props.onSelectedPluginMentionsChange ?? setInternalSelectedPluginMentions;
  const setSelectedFileMentions = props.onSelectedFileMentionsChange ?? setInternalSelectedFileMentions;
  const controlledSelections = Boolean(
    props.onSelectedFileMentionsChange &&
    props.onSelectedPluginMentionsChange &&
    props.onSelectedSkillMentionsChange
  );
  const fileSearchRequestRef = useRef(0);
  const skillSearchRequestRef = useRef(0);
  const pendingCaretRef = useRef<{ value: string; position: number } | undefined>();
  const fileSearchAvailable = Boolean(props.searchSource.repoPath?.trim()) && (
    props.searchSource.type === "pre-chat" || Boolean(props.searchSource.conversationId)
  );
  const skillSearchAvailable = props.searchSource.type === "pre-chat" || Boolean(props.searchSource.conversationId);
  // Artifacts come from the conversation-level provider; outside it (pre-chat)
  // the context is undefined and the "#" popover keeps its file-only behavior.
  const artifactsContext = useContext(ArtifactsContext);
  const artifactPool = artifactsContext ? Array.from(artifactsContext.byId.values()) : [];
  const hashTriggerAvailable = fileSearchAvailable || artifactPool.length > 0;
  const searchResetKey = props.searchSource.type === "conversation"
    ? `conversation:${props.searchSource.conversationId ?? ""}`
    : `pre-chat:${props.searchSource.repoPath ?? ""}`;
  const mentionOptions = mentionQuery === undefined
    ? []
    : props.participants.filter((participant) => {
      const query = mentionQuery.toLowerCase();
      return participant.handle.toLowerCase().includes(query) ||
        chatParticipantDisplayName(participant).toLowerCase().includes(query);
    });
  const visibleFileOptions = fileQuery === undefined ? [] : fileOptions;
  const visibleArtifactOptions = fileQuery === undefined ? [] : matchArtifactMentions(artifactPool, fileQuery);
  const visibleHashOptionCount = visibleArtifactOptions.length + visibleFileOptions.length;
  // What the search depends on: the draft without the "/query" being typed.
  // Main reads only the @mentions in it (the target), so typing the query
  // filters locally and only a new target searches again.
  const slashSearchContent = skillQuery === undefined ? undefined : props.draft.replace(/\/[A-Za-z0-9_-]*$/, "");
  // By value: New chat rebuilds its search source on every keystroke.
  const slashSearchSource = JSON.stringify(props.searchSource);
  const slashSearchKey = slashSearchContent === undefined ? undefined : `${slashSearchSource}\n${slashSearchContent}`;
  // Results answer the search they were made for: after the member before the
  // "/query" changes, the last member's rows are gone until the new answer.
  const slashFresh = slashSearchKey !== undefined && slashResultKey === slashSearchKey;
  const slashTarget = slashFresh ? skillTarget : undefined;
  const visiblePluginOptions = slashFresh ? pluginOptions.filter((plugin) => isSlashInvocablePlugin(plugin, slashTarget)) : [];
  const commandOptions = [
    goalCommandOption(slashTarget),
    props.searchSource.type === "conversation" ? compactCommandOption(slashTarget) : undefined
  ].filter((option): option is NonNullable<typeof option> => Boolean(option));
  const slashItems = skillQuery === undefined
    ? []
    : chatSlashItems({ commands: commandOptions, prompts: props.savedPrompts, skills: slashFresh ? skillOptions : [], plugins: visiblePluginOptions });
  const slashModel = buildSlashMenu(slashItems, skillQuery ?? "", slashExpanded);
  const slashActiveIndex = resolveSlashActive(slashModel.nav, slashActiveKey);
  // Saved prompts show at once (Enter on "/st" keeps inserting one); "No
  // matches" and the target wait for the search to answer.
  const slashMenu: ChatSlashMenuProps | undefined = skillQuery !== undefined && (slashModel.nav.length > 0 || slashTarget !== undefined)
    ? {
        menu: slashModel,
        activeIndex: slashActiveIndex,
        items: slashItems,
        query: skillQuery,
        searching: slashTarget === undefined,
        target: chatSlashTarget(slashTarget, props.participants),
        onActivate: activateSlashNavAtIndex,
        onHover: (index) => setSlashActiveAt(slashModel, index)
      }
    : undefined;
  const showSkillHighlights = draftHasMention(props.draft) ||
    draftHasArtifactMention(props.draft) ||
    selectedSkillMentions.some((mention) => draftHasSkillMention(props.draft, mention.frontmatterName)) ||
    selectedPluginMentions.some((mention) => draftHasSkillMention(props.draft, mention.name));

  useEffect(() => {
    setFileQuery(undefined);
    setFileOptions([]);
    setSkillQuery(undefined);
    setSkillOptions([]);
    setPluginOptions([]);
    setSkillTarget(undefined);
    if (!controlledSelections) {
      setSelectedSkillMentions([]);
      setSelectedPluginMentions([]);
      setSelectedFileMentions([]);
    }
  }, [searchResetKey]);

  useEffect(() => {
    setSelectedFileMentions((current) => current.filter((mention) => draftHasFileMention(props.draft, mention.path)));
  }, [props.draft]);

  useEffect(() => {
    setSelectedSkillMentions((current) => current.filter((mention) => draftHasSkillMention(props.draft, mention.frontmatterName)));
    setSelectedPluginMentions((current) => current.filter((mention) => draftHasSkillMention(props.draft, mention.name)));
  }, [props.draft]);

  useEffect(() => {
    if (props.mentionSeedKey === undefined) {
      return;
    }
    setSelectedSkillMentions((props.initialSkillMentions ?? []).filter((mention) => draftHasSkillMention(props.draft, mention.frontmatterName)));
    setSelectedPluginMentions((props.initialPluginMentions ?? []).filter((mention) => draftHasSkillMention(props.draft, mention.name)));
  }, [props.mentionSeedKey]);

  useEffect(() => {
    if (fileQuery === undefined || !fileSearchAvailable) {
      setFileOptions([]);
      return;
    }
    const requestId = fileSearchRequestRef.current + 1;
    fileSearchRequestRef.current = requestId;
    const timeout = window.setTimeout(() => {
      const request = props.searchSource.type === "conversation"
        ? {
            conversationId: props.searchSource.conversationId ?? "",
            query: fileQuery,
            limit: 50
          }
        : {
            repoPath: props.searchSource.repoPath ?? "",
            query: fileQuery,
            limit: 50
          };
      void window.consensus.searchRepoFiles(request).then((results) => {
        if (fileSearchRequestRef.current === requestId) {
          setFileOptions(results);
          setFileIndex(0);
        }
      }).catch(() => {
        if (fileSearchRequestRef.current === requestId) {
          setFileOptions([]);
        }
      });
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [fileQuery, fileSearchAvailable, props.searchSource]);

  useEffect(() => {
    if (slashSearchContent === undefined || !skillSearchAvailable) {
      setSkillOptions([]);
      setPluginOptions([]);
      setSkillTarget(undefined);
      return;
    }
    const requestId = skillSearchRequestRef.current + 1;
    skillSearchRequestRef.current = requestId;
    const timeout = window.setTimeout(() => {
      const search = { query: "", content: slashSearchContent, limit: SLASH_SEARCH_LIMIT };
      const source = props.searchSource;
      const request = source.type === "conversation"
        ? { ...search, conversationId: source.conversationId ?? "" }
        : { ...search, repoPath: source.repoPath, participants: source.participants, assistantProviderKind: source.assistantProviderKind };
      // Both lists land together: the target opens the menu, which must not
      // say "No matches" while the plugins are still on their way.
      void Promise.allSettled([window.consensus.searchUserSkills(request), window.consensus.listPlugins(request)]).then(([skills, plugins]) => {
        if (skillSearchRequestRef.current !== requestId) {
          return;
        }
        setSkillOptions(skills.status === "fulfilled" ? skills.value.skills : []);
        setSkillTarget(skills.status === "fulfilled" ? skills.value.target : NO_SLASH_TARGET);
        setPluginOptions(plugins.status === "fulfilled" ? plugins.value.plugins : []);
        setSlashResultKey(slashSearchKey);
      });
    }, 200);
    return () => {
      window.clearTimeout(timeout);
      // A reply still on its way after Esc or a new target is stale.
      skillSearchRequestRef.current += 1;
    };
  }, [slashSearchKey, skillSearchAvailable]);

  function updateDraft(value: string): void {
    const normalized = normalizeArtifactDraft(value, selectedPluginMentions);
    props.onDraftChange(normalized);
    const nextFileQuery = hashTriggerAvailable ? activeFileQuery(normalized) : undefined;
    const nextMentionQuery = nextFileQuery === undefined ? activeMentionQuery(normalized) : undefined;
    const nextSkillQuery = nextFileQuery === undefined && nextMentionQuery === undefined && skillSearchAvailable ? activeSkillQuery(normalized) : undefined;
    setFileQuery(nextFileQuery);
    setMentionQuery(nextMentionQuery);
    setSkillQuery(nextSkillQuery);
    setMentionIndex(0);
    setFileIndex(0);
    setSlashActiveKey(undefined);
    setSlashExpanded(NO_SLASH_KINDS);
  }

  function updateDraftWithCaret(value: string, position = value.length): void {
    const normalized = normalizeArtifactDraft(value, selectedPluginMentions);
    pendingCaretRef.current = { value: normalized, position: Math.min(position, normalized.length) };
    props.onDraftChange(normalized);
  }

  function insertMention(participant: ChatParticipant): void {
    updateDraftWithCaret(replaceActiveMention(props.draft, chatParticipantMentionHandle(participant, props.participants)));
    props.onMentionInserted?.(participant);
    setMentionQuery(undefined);
    setMentionIndex(0);
  }

  function insertFileMention(file: RepoFileSearchResult): void {
    updateDraftWithCaret(replaceActiveFileMention(props.draft, file.path));
    setSelectedFileMentions((current) => current.some((mention) => mention.path === file.path) ? current : [...current, { path: file.path }]);
    setFileQuery(undefined);
    setFileOptions([]);
    setFileIndex(0);
  }

  function insertArtifactMention(artifact: ArtifactSummary): void {
    updateDraftWithCaret(replaceActiveArtifactMention(props.draft, artifact));
    setFileQuery(undefined);
    setFileOptions([]);
    setFileIndex(0);
  }

  function insertHashOptionAtIndex(index: number): void {
    const artifact = visibleArtifactOptions[index];
    if (artifact) {
      insertArtifactMention(artifact);
      return;
    }
    const file = visibleFileOptions[index - visibleArtifactOptions.length] ?? visibleFileOptions[0];
    if (file) {
      insertFileMention(file);
    }
  }

  function insertSkillMention(skill: UserSkillSummary): void {
    if (skill.capabilityState !== "invocable" || skill.ambiguous) {
      return;
    }
    updateDraftWithCaret(replaceActiveSkillMention(props.draft, skill.frontmatterName));
    setSelectedSkillMentions((current) => {
      if (current.some((mention) => mention.skillId === skill.skillId)) {
        return current;
      }
      const { providerKinds: _providerKinds, scopeKinds: _scopeKinds, statusMessage: _statusMessage, ambiguous: _ambiguous, ...mention } = skill;
      return [...current, mention];
    });
    setSkillQuery(undefined);
    setSkillOptions([]);
    setPluginOptions([]);
    setSkillTarget(undefined);
    setSlashActiveKey(undefined);
  }

  function insertSavedPrompt(prompt: ChatSavedPromptConfig): void {
    updateDraftWithCaret(replaceActiveSlashToken(props.draft, prompt.body));
    setSkillQuery(undefined);
    setSkillOptions([]);
    setPluginOptions([]);
    setSkillTarget(undefined);
    setSlashActiveKey(undefined);
  }

  function insertCommand(command: "compact" | "goal"): void {
    updateDraftWithCaret(replaceActiveSkillMention(props.draft, command));
    setSkillQuery(undefined);
    setSkillOptions([]);
    setPluginOptions([]);
    setSkillTarget(undefined);
    setSlashActiveKey(undefined);
  }

  function insertPluginMention(plugin: PluginCatalogItem): void {
    const invocation = plugin.invocation;
    if (invocation.kind === "skill-mention") {
      insertSkillMention(invocation.skill);
      return;
    }
    // The slash picker selects an installed tool. Its manifest defaultPrompt is
    // reserved for the Settings "Try in chat" shortcut and must not overwrite
    // what the user intends to write in the composer.
    updateDraftWithCaret(replaceActivePluginMention(props.draft, plugin.name));
    setSelectedPluginMentions((current) => {
      if (current.some((mention) => mention.name === plugin.name)) {
        return current;
      }
      return [...current, { name: plugin.name, displayName: plugin.displayName, iconUrl: plugin.iconUrl }];
    });
    setSkillQuery(undefined);
    setSkillOptions([]);
    setPluginOptions([]);
    setSkillTarget(undefined);
    setSlashActiveKey(undefined);
  }

  function activateSlashNavAtIndex(index: number): void {
    const entry = slashModel.nav[index];
    if (entry?.type === "more" || entry?.type === "less") {
      const expanded = withSlashKind(slashExpanded, entry.kind, entry.type === "more");
      setSlashExpanded(expanded);
      // Show all leaves the highlight on the first row it showed; Show fewer
      // puts it back on the group's Show all row.
      if (entry.type === "more") {
        setSlashActiveAt(buildSlashMenu(slashItems, skillQuery ?? "", expanded), index);
      } else {
        setSlashActiveKey(slashMoreKey(entry.kind));
      }
      return;
    }
    const selection = entry?.item.value;
    if (selection?.kind === "command") {
      insertCommand(selection.item.id);
    } else if (selection?.kind === "prompt") {
      insertSavedPrompt(selection.item);
    } else if (selection?.kind === "skill") {
      insertSkillMention(selection.item);
    } else if (selection?.kind === "plugin") {
      insertPluginMention(selection.item);
    }
  }

  function moveSlashActive(step: number): void {
    setSlashActiveAt(slashModel, stepSlashActive(slashModel.nav.length, slashActiveIndex, step));
  }

  function setSlashActiveAt(menu: typeof slashModel, index: number): void {
    const entry = menu.nav[index];
    setSlashActiveKey(entry ? slashNavKey(entry) : undefined);
  }

  function removeFileMention(filePath: string): void {
    props.onDraftChange(removeFileMentionToken(props.draft, filePath));
    setSelectedFileMentions((current) => current.filter((mention) => mention.path !== filePath));
  }

  function removeSkillMention(mention: ChatSkillMention): void {
    props.onDraftChange(removeSkillMentionToken(props.draft, mention.frontmatterName));
    setSelectedSkillMentions((current) => current.filter((item) => item.skillId !== mention.skillId));
  }

  return {
    fileIndex,
    fileOptions,
    insertArtifactMention,
    insertCommand,
    insertFileMention,
    insertHashOptionAtIndex,
    insertMention,
    insertSavedPrompt,
    insertSkillMention,
    insertPluginMention,
    activateSlashNavAtIndex,
    moveSlashActive,
    mentionIndex,
    mentionOptions,
    pendingCaretRef,
    removeFileMention,
    removeSkillMention,
    selectedFileMentions,
    selectedPluginMentions,
    selectedSkillMentions,
    setFileIndex,
    setFileQuery,
    setMentionIndex,
    setMentionQuery,
    setSelectedFileMentions,
    setSelectedPluginMentions,
    setSelectedSkillMentions,
    setSkillQuery,
    showSkillHighlights,
    skillQuery,
    slashActiveIndex,
    slashMenu,
    slashNavCount: slashModel.nav.length,
    slashSearching: skillQuery !== undefined && slashTarget === undefined,
    updateDraft,
    visibleArtifactOptions,
    visibleFileOptions,
    visibleHashOptionCount
  };
}

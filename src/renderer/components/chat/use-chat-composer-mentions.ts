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
  matchingChatSavedPrompts
} from "../../../shared/chatSavedPrompts";
import {
  slashSuggestionAtIndex,
  slashSuggestionCount
} from "../../../shared/slashSuggestions";
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
  draftHasArtifactMention,
  draftHasFileMention,
  draftHasSkillMention,
  matchArtifactMentions,
  normalizeArtifactDraft,
  removeFileMentionToken,
  removeSkillMentionToken,
  replaceActiveArtifactMention,
  replaceActiveFileMention,
  replaceActiveMention,
  replaceActiveSkillMention,
  replaceActiveSlashToken,
  type DraftPluginMention,
  skillPickerTargetLabel
} from "./chat-composer-draft-utils";
import { isSlashInvocablePlugin } from "./chat-plugin-options";

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
}): {
  fileIndex: number;
  fileOptions: RepoFileSearchResult[];
  insertArtifactMention: (artifact: ArtifactSummary) => void;
  insertCompactCommand: () => void;
  insertFileMention: (file: RepoFileSearchResult) => void;
  insertHashOptionAtIndex: (index: number) => void;
  insertMention: (participant: ChatParticipant) => void;
  insertSavedPrompt: (prompt: ChatSavedPromptConfig) => void;
  insertSkillMention: (skill: UserSkillSummary) => void;
  insertPluginMention: (plugin: PluginCatalogItem) => void;
  insertSlashOptionAtIndex: (index: number) => void;
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
  setSkillIndex: React.Dispatch<React.SetStateAction<number>>;
  setSkillQuery: React.Dispatch<React.SetStateAction<string | undefined>>;
  showSkillHighlights: boolean;
  skillIndex: number;
  skillQuery: string | undefined;
  skillTargetLabel?: string;
  updateDraft: (value: string) => void;
  visibleArtifactOptions: ArtifactSummary[];
  visibleCommandOptions: NonNullable<ReturnType<typeof compactCommandOption>>[];
  visibleFileOptions: RepoFileSearchResult[];
  visibleHashOptionCount: number;
  visiblePromptOptions: ChatSavedPromptConfig[];
  visibleSkillOptions: UserSkillSummary[];
  visiblePluginOptions: PluginCatalogItem[];
  visibleSlashOptionCount: number;
} {
  const [mentionQuery, setMentionQuery] = useState<string | undefined>();
  const [mentionIndex, setMentionIndex] = useState(0);
  const [fileQuery, setFileQuery] = useState<string | undefined>();
  const [fileIndex, setFileIndex] = useState(0);
  const [fileOptions, setFileOptions] = useState<RepoFileSearchResult[]>([]);
  const [skillQuery, setSkillQuery] = useState<string | undefined>();
  const [skillIndex, setSkillIndex] = useState(0);
  const [skillOptions, setSkillOptions] = useState<UserSkillSummary[]>([]);
  const [pluginOptions, setPluginOptions] = useState<PluginCatalogItem[]>([]);
  const [skillTarget, setSkillTarget] = useState<UserSkillTargetSummary | undefined>();
  const [selectedSkillMentions, setSelectedSkillMentions] = useState<ChatSkillMention[]>([]);
  const [selectedPluginMentions, setSelectedPluginMentions] = useState<DraftPluginMention[]>([]);
  const [selectedFileMentions, setSelectedFileMentions] = useState<RepoFileMention[]>([]);
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
  const visiblePromptOptions = skillQuery === undefined
    ? []
    : matchingChatSavedPrompts(props.savedPrompts, skillQuery, { includeBody: false });
  const visibleSkillOptions = skillQuery === undefined ? [] : skillOptions;
  const visiblePluginOptions = skillQuery === undefined ? [] : pluginOptions.filter((plugin) => isSlashInvocablePlugin(plugin, skillTarget));
  const skillTargetLabel = skillTarget ? skillPickerTargetLabel(skillTarget, props.participants) : undefined;
  const compactOption = props.searchSource.type === "conversation" ? compactCommandOption(skillQuery, skillTarget) : undefined;
  const visibleCommandOptions = compactOption ? [compactOption] : [];
  const visibleSlashOptionCount = slashSuggestionCount({
    commands: visibleCommandOptions,
    prompts: visiblePromptOptions,
    skills: visibleSkillOptions,
    plugins: visiblePluginOptions
  });
  const showSkillHighlights = draftHasArtifactMention(props.draft) ||
    selectedSkillMentions.some((mention) => draftHasSkillMention(props.draft, mention.frontmatterName)) ||
    selectedPluginMentions.some((mention) => draftHasSkillMention(props.draft, mention.name));

  useEffect(() => {
    setFileQuery(undefined);
    setFileOptions([]);
    setSkillQuery(undefined);
    setSkillOptions([]);
    setPluginOptions([]);
    setSkillTarget(undefined);
    setSelectedSkillMentions([]);
    setSelectedPluginMentions([]);
    setSelectedFileMentions([]);
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
    if (skillQuery === undefined || !skillSearchAvailable) {
      setSkillOptions([]);
      setPluginOptions([]);
      return;
    }
    const requestId = skillSearchRequestRef.current + 1;
    skillSearchRequestRef.current = requestId;
    const timeout = window.setTimeout(() => {
      const request = props.searchSource.type === "conversation"
        ? {
            conversationId: props.searchSource.conversationId ?? "",
            query: skillQuery,
            content: props.draft,
            limit: 50
          }
        : {
            repoPath: props.searchSource.repoPath,
            participants: props.searchSource.participants,
            query: skillQuery,
            content: props.draft,
            limit: 50
          };
      void window.consensus.searchUserSkills(request).then((result) => {
        if (skillSearchRequestRef.current === requestId) {
          setSkillOptions(result.skills);
          setSkillTarget(result.target);
          setSkillIndex(0);
        }
      }).catch(() => {
        if (skillSearchRequestRef.current === requestId) {
          setSkillOptions([]);
          setPluginOptions([]);
          setSkillTarget(undefined);
        }
      });
      void window.consensus.listPlugins(request).then((result) => {
        if (skillSearchRequestRef.current === requestId) {
          setPluginOptions(result.plugins);
          setSkillIndex(0);
        }
      }).catch(() => {
        if (skillSearchRequestRef.current === requestId) {
          setPluginOptions([]);
        }
      });
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [skillQuery, skillSearchAvailable, props.draft, props.searchSource]);

  function updateDraft(value: string): void {
    const normalized = normalizeArtifactDraft(value);
    props.onDraftChange(normalized);
    const nextFileQuery = hashTriggerAvailable ? activeFileQuery(normalized) : undefined;
    const nextMentionQuery = nextFileQuery === undefined ? activeMentionQuery(normalized) : undefined;
    const nextSkillQuery = nextFileQuery === undefined && nextMentionQuery === undefined && skillSearchAvailable ? activeSkillQuery(normalized) : undefined;
    setFileQuery(nextFileQuery);
    setMentionQuery(nextMentionQuery);
    setSkillQuery(nextSkillQuery);
    setMentionIndex(0);
    setFileIndex(0);
    setSkillIndex(0);
  }

  function updateDraftWithCaret(value: string, position = value.length): void {
    const normalized = normalizeArtifactDraft(value);
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
    setSkillIndex(0);
  }

  function insertSavedPrompt(prompt: ChatSavedPromptConfig): void {
    updateDraftWithCaret(replaceActiveSlashToken(props.draft, prompt.body));
    setSkillQuery(undefined);
    setSkillOptions([]);
    setPluginOptions([]);
    setSkillTarget(undefined);
    setSkillIndex(0);
  }

  function insertCompactCommand(): void {
    updateDraftWithCaret(replaceActiveSkillMention(props.draft, "compact"));
    setSkillQuery(undefined);
    setSkillOptions([]);
    setPluginOptions([]);
    setSkillTarget(undefined);
    setSkillIndex(0);
  }

  function insertPluginMention(plugin: PluginCatalogItem): void {
    const invocation = plugin.invocation;
    if (invocation.kind === "skill-mention") {
      insertSkillMention(invocation.skill);
      return;
    }
    const insertPluginToken = invocation.kind === "mcp-passive" || plugin.installedProviderKinds.length > 0;
    if (insertPluginToken) {
      const prompt = invocation.kind === "prompt-insert" ? invocation.prompt.trim() : "";
      updateDraftWithCaret(prompt
        ? replaceActiveSlashToken(props.draft, `/${plugin.name} ${prompt}`)
        : replaceActiveSkillMention(props.draft, plugin.name));
      setSelectedPluginMentions((current) => {
        if (current.some((mention) => mention.name === plugin.name)) {
          return current;
        }
        return [...current, { name: plugin.name, displayName: plugin.displayName, iconUrl: plugin.iconUrl }];
      });
    } else if (invocation.kind === "prompt-insert") {
      updateDraftWithCaret(replaceActiveSlashToken(props.draft, invocation.prompt));
    }
    setSkillQuery(undefined);
    setSkillOptions([]);
    setPluginOptions([]);
    setSkillTarget(undefined);
    setSkillIndex(0);
  }

  function insertSlashOptionAtIndex(index: number): void {
    const selection = slashSuggestionAtIndex({
      commands: visibleCommandOptions,
      prompts: visiblePromptOptions,
      skills: visibleSkillOptions,
      plugins: visiblePluginOptions
    }, index);
    if (!selection) {
      return;
    }
    if (selection.kind === "command") {
      insertCompactCommand();
    } else if (selection.kind === "prompt") {
      insertSavedPrompt(selection.item);
    } else if (selection.kind === "skill") {
      insertSkillMention(selection.item);
    } else {
      insertPluginMention(selection.item);
    }
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
    insertCompactCommand,
    insertFileMention,
    insertHashOptionAtIndex,
    insertMention,
    insertSavedPrompt,
    insertSkillMention,
    insertPluginMention,
    insertSlashOptionAtIndex,
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
    setSkillIndex,
    setSkillQuery,
    showSkillHighlights,
    skillIndex,
    skillQuery,
    skillTargetLabel,
    updateDraft,
    visibleArtifactOptions,
    visibleCommandOptions,
    visibleFileOptions,
    visibleHashOptionCount,
    visiblePromptOptions,
    visibleSkillOptions,
    visiblePluginOptions,
    visibleSlashOptionCount
  };
}

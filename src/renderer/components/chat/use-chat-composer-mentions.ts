import { useEffect, useRef, useState } from "react";

import type {
  ChatParticipant,
  ChatSkillMention,
  RepoFileMention,
  RepoFileSearchResult,
  UserSkillSummary,
  UserSkillTargetSummary
} from "../../../shared/types";
import { chatParticipantMentionHandle } from "../conversation/conversation-display";
import {
  activeFileQuery,
  activeMentionQuery,
  activeSkillQuery,
  compactCommandOption,
  draftHasFileMention,
  draftHasSkillMention,
  removeFileMentionToken,
  removeSkillMentionToken,
  replaceActiveFileMention,
  replaceActiveMention,
  replaceActiveSkillMention,
  skillPickerTargetLabel
} from "./chat-composer-draft-utils";

export function useChatComposerMentions(props: {
  conversationId?: string;
  draft: string;
  onDraftChange: (value: string) => void;
  participants: ChatParticipant[];
  repoPath?: string;
}): {
  fileIndex: number;
  fileOptions: RepoFileSearchResult[];
  insertCompactCommand: () => void;
  insertFileMention: (file: RepoFileSearchResult) => void;
  insertMention: (participant: ChatParticipant) => void;
  insertSkillMention: (skill: UserSkillSummary) => void;
  insertSlashOptionAtIndex: (index: number) => void;
  mentionIndex: number;
  mentionOptions: ChatParticipant[];
  pendingCaretRef: React.MutableRefObject<{ value: string; position: number } | undefined>;
  removeFileMention: (filePath: string) => void;
  removeSkillMention: (mention: ChatSkillMention) => void;
  selectedFileMentions: RepoFileMention[];
  selectedSkillMentions: ChatSkillMention[];
  setFileIndex: React.Dispatch<React.SetStateAction<number>>;
  setFileQuery: React.Dispatch<React.SetStateAction<string | undefined>>;
  setMentionIndex: React.Dispatch<React.SetStateAction<number>>;
  setMentionQuery: React.Dispatch<React.SetStateAction<string | undefined>>;
  setSelectedFileMentions: React.Dispatch<React.SetStateAction<RepoFileMention[]>>;
  setSelectedSkillMentions: React.Dispatch<React.SetStateAction<ChatSkillMention[]>>;
  setSkillIndex: React.Dispatch<React.SetStateAction<number>>;
  setSkillQuery: React.Dispatch<React.SetStateAction<string | undefined>>;
  showSkillHighlights: boolean;
  skillIndex: number;
  skillQuery: string | undefined;
  skillTargetLabel?: string;
  updateDraft: (value: string) => void;
  visibleCommandOptions: NonNullable<ReturnType<typeof compactCommandOption>>[];
  visibleFileOptions: RepoFileSearchResult[];
  visibleSkillOptions: UserSkillSummary[];
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
  const [skillTarget, setSkillTarget] = useState<UserSkillTargetSummary | undefined>();
  const [selectedSkillMentions, setSelectedSkillMentions] = useState<ChatSkillMention[]>([]);
  const [selectedFileMentions, setSelectedFileMentions] = useState<RepoFileMention[]>([]);
  const fileSearchRequestRef = useRef(0);
  const skillSearchRequestRef = useRef(0);
  const pendingCaretRef = useRef<{ value: string; position: number } | undefined>();
  const mentionOptions = mentionQuery === undefined
    ? []
    : props.participants.filter((participant) => participant.handle.toLowerCase().includes(mentionQuery.toLowerCase()));
  const visibleFileOptions = fileQuery === undefined ? [] : fileOptions;
  const visibleSkillOptions = skillQuery === undefined ? [] : skillOptions;
  const skillTargetLabel = skillTarget ? skillPickerTargetLabel(skillTarget, props.participants) : undefined;
  const compactOption = compactCommandOption(skillQuery, skillTarget);
  const visibleCommandOptions = compactOption ? [compactOption] : [];
  const visibleSlashOptionCount = visibleCommandOptions.length + visibleSkillOptions.length;
  const showSkillHighlights = selectedSkillMentions.some((mention) => draftHasSkillMention(props.draft, mention.frontmatterName));

  useEffect(() => {
    setFileQuery(undefined);
    setFileOptions([]);
    setSkillQuery(undefined);
    setSkillOptions([]);
    setSkillTarget(undefined);
    setSelectedSkillMentions([]);
    setSelectedFileMentions([]);
  }, [props.conversationId]);

  useEffect(() => {
    setSelectedFileMentions((current) => current.filter((mention) => draftHasFileMention(props.draft, mention.path)));
  }, [props.draft]);

  useEffect(() => {
    setSelectedSkillMentions((current) => current.filter((mention) => draftHasSkillMention(props.draft, mention.frontmatterName)));
  }, [props.draft]);

  useEffect(() => {
    if (fileQuery === undefined || !props.conversationId || !props.repoPath) {
      setFileOptions([]);
      return;
    }
    const requestId = fileSearchRequestRef.current + 1;
    fileSearchRequestRef.current = requestId;
    const timeout = window.setTimeout(() => {
      void window.consensus.searchRepoFiles({
        conversationId: props.conversationId ?? "",
        query: fileQuery,
        limit: 50
      }).then((results) => {
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
  }, [fileQuery, props.conversationId, props.repoPath]);

  useEffect(() => {
    if (skillQuery === undefined || !props.conversationId) {
      setSkillOptions([]);
      return;
    }
    const requestId = skillSearchRequestRef.current + 1;
    skillSearchRequestRef.current = requestId;
    const timeout = window.setTimeout(() => {
      void window.consensus.searchUserSkills({
        conversationId: props.conversationId ?? "",
        query: skillQuery,
        content: props.draft,
        limit: 50
      }).then((result) => {
        if (skillSearchRequestRef.current === requestId) {
          setSkillOptions(result.skills);
          setSkillTarget(result.target);
          setSkillIndex(0);
        }
      }).catch(() => {
        if (skillSearchRequestRef.current === requestId) {
          setSkillOptions([]);
          setSkillTarget(undefined);
        }
      });
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [skillQuery, props.conversationId, props.draft]);

  function updateDraft(value: string): void {
    props.onDraftChange(value);
    const nextFileQuery = props.conversationId && props.repoPath ? activeFileQuery(value) : undefined;
    const nextMentionQuery = nextFileQuery === undefined ? activeMentionQuery(value) : undefined;
    const nextSkillQuery = nextFileQuery === undefined && nextMentionQuery === undefined ? activeSkillQuery(value) : undefined;
    setFileQuery(nextFileQuery);
    setMentionQuery(nextMentionQuery);
    setSkillQuery(nextSkillQuery);
    setMentionIndex(0);
    setFileIndex(0);
    setSkillIndex(0);
  }

  function updateDraftWithCaret(value: string, position = value.length): void {
    pendingCaretRef.current = { value, position };
    props.onDraftChange(value);
  }

  function insertMention(participant: ChatParticipant): void {
    updateDraftWithCaret(replaceActiveMention(props.draft, chatParticipantMentionHandle(participant, props.participants)));
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
    setSkillTarget(undefined);
    setSkillIndex(0);
  }

  function insertCompactCommand(): void {
    updateDraftWithCaret(replaceActiveSkillMention(props.draft, "compact"));
    setSkillQuery(undefined);
    setSkillOptions([]);
    setSkillTarget(undefined);
    setSkillIndex(0);
  }

  function insertSlashOptionAtIndex(index: number): void {
    if (index < visibleCommandOptions.length) {
      insertCompactCommand();
      return;
    }
    const skill = visibleSkillOptions[index - visibleCommandOptions.length];
    if (skill) {
      insertSkillMention(skill);
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
    insertCompactCommand,
    insertFileMention,
    insertMention,
    insertSkillMention,
    insertSlashOptionAtIndex,
    mentionIndex,
    mentionOptions,
    pendingCaretRef,
    removeFileMention,
    removeSkillMention,
    selectedFileMentions,
    selectedSkillMentions,
    setFileIndex,
    setFileQuery,
    setMentionIndex,
    setMentionQuery,
    setSelectedFileMentions,
    setSelectedSkillMentions,
    setSkillIndex,
    setSkillQuery,
    showSkillHighlights,
    skillIndex,
    skillQuery,
    skillTargetLabel,
    updateDraft,
    visibleCommandOptions,
    visibleFileOptions,
    visibleSkillOptions,
    visibleSlashOptionCount
  };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Send, Square } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type {
  AvatarStudioCandidate,
  AvatarStudioProviderKind,
  AvatarStudioRunner
} from "../../../shared/avatarStudio";
import { AVATAR_STUDIO_PROVIDER_KINDS, avatarStudioNeedsSeed, customAvatarId, isAvatarStudioProviderKind } from "../../../shared/avatarStudio";
import type { AgentHealth, AppSettings, ChatProviderKind, ChatReasoningEffort, ProviderModel } from "../../../shared/types";
import { readyProviderKinds } from "../../../shared/cliReadiness";
import { chatCliProviderLabel } from "../chat/chat-participant-drafts";
import { ChatParticipantInlineSelectRow } from "../chat/chat-participant-config-panel";
import { rememberCustomAvatar } from "./custom-avatars";

interface StudioMessage {
  id: string;
  author: "user" | "runner";
  text: string;
  failed?: boolean;
}

const REASONING_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "CLI default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" }
];

// A studio window keeps one id for its whole life: the main process keys the
// drawing sessions and their scratch directories by it.
function newStudioId(): string {
  return `studio-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export function AvatarStudioDialog(props: {
  open: boolean;
  member: { handle: string; roleLabel?: string; kind: ChatProviderKind };
  settings: AppSettings;
  agents: AgentHealth[];
  onOpenChange: (open: boolean) => void;
  onUseAvatar: (avatarId: string) => void;
}): JSX.Element {
  const [studioId, setStudioId] = useState(newStudioId);
  const [providerKind, setProviderKind] = useState<AvatarStudioProviderKind>("codex-cli");
  const [model, setModel] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [messages, setMessages] = useState<StudioMessage[]>([]);
  const [candidates, setCandidates] = useState<AvatarStudioCandidate[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const openedBefore = useRef(false);

  const drawingProviders = useMemo(() => {
    const ready = readyProviderKinds(props.agents, props.settings.providers);
    return AVATAR_STUDIO_PROVIDER_KINDS.filter((kind) => ready.includes(kind));
  }, [props.agents, props.settings.providers]);

  const selected = candidates.find((candidate) => candidate.id === selectedId) ?? candidates[candidates.length - 1];
  const modelOptions = useMemo(
    () => [{ value: "", label: "CLI default" }, ...models.map((entry) => ({ value: entry.id, label: entry.label ?? entry.id }))],
    [models]
  );

  // Opening the window starts a fresh studio: new id, empty history, and the
  // member's own provider preselected when it can draw.
  useEffect(() => {
    if (!props.open) {
      return;
    }
    // Rotate the id only on a re-open. Rotating on the first open would leave the
    // mount's id behind as a studio nobody opened, closed by the cleanup below.
    if (openedBefore.current) {
      setStudioId(newStudioId());
    }
    openedBefore.current = true;
    setMessages([]);
    setCandidates([]);
    setSelectedId(undefined);
    setPrompt("");
    setBusy(false);
    const preferred = isAvatarStudioProviderKind(props.member.kind) && drawingProviders.includes(props.member.kind)
      ? props.member.kind
      : drawingProviders[0];
    if (preferred) {
      setProviderKind(preferred);
    }
    setModel("");
    setReasoning("");
    window.setTimeout(() => inputRef.current?.focus(), 50);
    // Only a fresh open resets the window; provider changes must not wipe the strip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    let cancelled = false;
    void window.consensus.listProviderModels(providerKind).then((catalog) => {
      if (!cancelled) {
        setModels(catalog.models);
      }
    }).catch(() => {
      if (!cancelled) {
        setModels([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [props.open, providerKind]);

  // Unmounting counts as closing: a popover that closes under the dialog, a
  // renderer reload, or a quit must not leave a CLI running on the user's
  // subscription with a scratch directory behind it.
  useEffect(() => () => {
    void window.consensus.closeAvatarStudio(studioId).catch(() => {});
  }, [studioId]);

  const closeStudio = useCallback((open: boolean) => {
    if (!open) {
      void window.consensus.closeAvatarStudio(studioId).catch(() => {});
    }
    props.onOpenChange(open);
  }, [props, studioId]);

  async function send(): Promise<void> {
    const text = prompt.trim();
    if (!text || busy || drawingProviders.length === 0) {
      return;
    }
    const runner: AvatarStudioRunner = {
      kind: providerKind,
      model: model || undefined,
      reasoningEffort: (reasoning || undefined) as ChatReasoningEffort | undefined
    };
    setMessages((current) => [...current, { id: `u-${Date.now()}`, author: "user", text }]);
    setPrompt("");
    setBusy(true);
    try {
      const needsSeed = avatarStudioNeedsSeed(selected, runner);
      const result = await window.consensus.runAvatarStudioTurn({
        studioId,
        prompt: text,
        runner,
        member: { handle: props.member.handle, roleLabel: props.member.roleLabel },
        baseCandidate: needsSeed ? { mediaType: selected.mediaType, dataUrl: selected.dataUrl } : undefined
      });
      if (result.candidate) {
        setCandidates((current) => [...current, result.candidate as AvatarStudioCandidate]);
        setSelectedId(result.candidate.id);
      }
      const answer = result.ok ? result.reply ?? "Готово." : result.error ?? "Не получилось.";
      setMessages((current) => [...current, { id: `r-${Date.now()}`, author: "runner", text: answer, failed: !result.ok }]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMessages((current) => [...current, { id: `r-${Date.now()}`, author: "runner", text: message, failed: true }]);
    } finally {
      setBusy(false);
    }
  }

  async function useAvatar(): Promise<void> {
    if (!selected || saving) {
      return;
    }
    setSaving(true);
    try {
      const settings = await window.consensus.saveCustomAvatar({
        mediaType: selected.mediaType,
        dataBase64: selected.dataUrl.slice(selected.dataUrl.indexOf(",") + 1),
        label: `@${props.member.handle}`
      });
      const saved = settings.chatCustomAvatars[settings.chatCustomAvatars.length - 1];
      if (saved) {
        rememberCustomAvatar(saved.id, selected.dataUrl);
        props.onUseAvatar(customAvatarId(saved.id));
      }
      closeStudio(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMessages((current) => [...current, { id: `s-${Date.now()}`, author: "runner", text: message, failed: true }]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={closeStudio}>
      <DialogContent className="avatar-studio-dialog" data-testid="avatar-studio-dialog">
        <DialogHeader className="avatar-studio-head">
          <div>
            <DialogTitle>Нарисовать аватар</DialogTitle>
            <DialogDescription>
              Для @{props.member.handle}
              {props.member.roleLabel ? ` — ${props.member.roleLabel}` : ""}
            </DialogDescription>
          </div>
          <div className="avatar-studio-runner">
            <ChatParticipantInlineSelectRow
              label="Рисует"
              value={chatCliProviderLabel(providerKind)}
              current={providerKind}
              options={drawingProviders.map((kind) => ({ value: kind, label: chatCliProviderLabel(kind) }))}
              onSelect={(value: string) => setProviderKind(value as AvatarStudioProviderKind)}
            />
            <ChatParticipantInlineSelectRow
              label="Модель"
              value={modelOptions.find((option) => option.value === model)?.label ?? "CLI default"}
              current={model}
              options={modelOptions}
              searchable
              onSelect={(value: string) => setModel(value)}
            />
            <ChatParticipantInlineSelectRow
              label="Reasoning"
              value={REASONING_OPTIONS.find((option) => option.value === reasoning)?.label ?? "CLI default"}
              current={reasoning}
              options={REASONING_OPTIONS}
              onSelect={(value: string) => setReasoning(value)}
            />
          </div>
          <p className="avatar-studio-note">
            {drawingProviders.length === 0
              ? "Нет установленного CLI, который умеет рисовать: подключите Codex или Claude Code."
              : `Рисует ${chatCliProviderLabel(providerKind)}, тратит вашу подписку.`}
          </p>
        </DialogHeader>

        <div className="avatar-studio-body">
          <div className="avatar-studio-preview">
            <div className="avatar-studio-canvas" data-testid="avatar-studio-canvas">
              {selected ? (
                <img src={selected.dataUrl} alt="" />
              ) : (
                <span className="avatar-studio-empty">Здесь появится аватар. Напишите, кого нарисовать.</span>
              )}
            </div>
            {selected && (
              <div className="avatar-studio-sizes" aria-hidden>
                <span className="avatar-studio-size is-message"><img src={selected.dataUrl} alt="" /></span>
                <span className="avatar-studio-size is-roster"><img src={selected.dataUrl} alt="" /></span>
                <small>как в ленте и в списке участников</small>
              </div>
            )}
            {candidates.length > 0 && (
              <div className="avatar-studio-strip" role="listbox" aria-label="Кандидаты">
                {candidates.map((candidate) => (
                  <button
                    type="button"
                    key={candidate.id}
                    className={`avatar-studio-thumb${candidate.id === selected?.id ? " selected" : ""}`}
                    title={`${chatCliProviderLabel(candidate.drawnBy.kind)}${candidate.drawnBy.model ? ` · ${candidate.drawnBy.model}` : ""}`}
                    aria-selected={candidate.id === selected?.id}
                    role="option"
                    onClick={() => setSelectedId(candidate.id)}
                  >
                    <img src={candidate.dataUrl} alt="" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="avatar-studio-chat">
            <div className="avatar-studio-messages" data-testid="avatar-studio-messages">
              {messages.map((message) => (
                <div key={message.id} className={`avatar-studio-message is-${message.author}${message.failed ? " is-failed" : ""}`}>
                  {message.text}
                </div>
              ))}
              {busy && (
                <div className="avatar-studio-message is-runner is-busy">
                  <Loader2 size={14} className="spin" aria-hidden /> рисует…
                </div>
              )}
            </div>
            <div className="avatar-studio-composer">
              <textarea
                ref={inputRef}
                value={prompt}
                placeholder="Например: рыжая лиса в фиолетовой худи"
                data-testid="avatar-studio-prompt"
                disabled={drawingProviders.length === 0}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              {busy ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void window.consensus.cancelAvatarStudioTurn(studioId)}
                >
                  <Square size={14} aria-hidden /> Прервать
                </Button>
              ) : (
                <Button type="button" size="sm" disabled={!prompt.trim() || drawingProviders.length === 0} onClick={() => void send()}>
                  <Send size={14} aria-hidden /> Отправить
                </Button>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="avatar-studio-footer">
          <Button type="button" variant="ghost" onClick={() => closeStudio(false)}>Отмена</Button>
          <Button
            type="button"
            disabled={!selected || saving}
            data-testid="avatar-studio-use"
            onClick={() => void useAvatar()}
          >
            Использовать этот аватар
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

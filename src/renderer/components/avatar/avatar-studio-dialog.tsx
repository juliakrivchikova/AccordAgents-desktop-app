import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Send, Square, X } from "lucide-react";

import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import type {
  AvatarStudioCandidate,
  AvatarStudioProviderKind,
  AvatarStudioRunner
} from "../../../shared/avatarStudio";
import {
  AVATAR_STUDIO_PROVIDER_KINDS,
  avatarStudioNeedsSeed,
  avatarStudioReasoningOptions,
  customAvatarId,
  isAvatarStudioProviderKind
} from "../../../shared/avatarStudio";
import type { AgentHealth, AppSettings, ChatProviderKind, ChatReasoningEffort, ProviderModel } from "../../../shared/types";
import { readyProviderKinds } from "../../../shared/cliReadiness";
import { reasoningEffortOptionsForProvider } from "../../../shared/reasoningEffort";
import { chatCliProviderLabel } from "../chat/chat-participant-drafts";
import { rememberCustomAvatar } from "./custom-avatars";

interface StudioMessage {
  id: string;
  author: "user" | "runner";
  text: string;
  failed?: boolean;
}

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
  // The same per-provider list the member settings use, so Codex keeps Extra
  // High / Max / Ultra instead of a shorter list invented here.
  const reasoningOptions = useMemo(() => avatarStudioReasoningOptions(providerKind), [providerKind]);
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

  function changeProvider(kind: AvatarStudioProviderKind): void {
    setProviderKind(kind);
    // Model and effort belong to a provider; carrying them over would send a
    // value the new CLI does not know.
    setModel("");
    if (reasoning && !reasoningEffortOptionsForProvider(kind).some((option) => option.id === reasoning)) {
      setReasoning("");
    }
  }

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

  const noDrawingProvider = drawingProviders.length === 0;

  return (
    <Dialog open={props.open} onOpenChange={closeStudio}>
      <DialogContent className="avatar-studio-dialog" data-testid="avatar-studio-dialog" showCloseButton={false}>
        <DialogHeader className="avatar-studio-head">
          <div className="avatar-studio-head-row">
            <span className="avatar-studio-title-block">
              <DialogTitle>Draw an avatar</DialogTitle>
              <DialogDescription>
                For @{props.member.handle}
                {props.member.roleLabel ? ` · ${props.member.roleLabel}` : ""}
              </DialogDescription>
            </span>
            <DialogClose asChild>
              <button type="button" className="avatar-studio-close" aria-label="Close avatar studio">
                <X size={15} aria-hidden />
              </button>
            </DialogClose>
          </div>
        </DialogHeader>

        <div className="avatar-studio-body">
          <div className="avatar-studio-preview">
            <div className="avatar-studio-canvas" data-testid="avatar-studio-canvas">
              {selected ? (
                <img src={selected.dataUrl} alt="" />
              ) : (
                <span className="avatar-studio-empty">The avatar appears here</span>
              )}
            </div>
            {selected && (
              <div className="avatar-studio-sizes">
                <span className="avatar-studio-size is-message" aria-hidden><img src={selected.dataUrl} alt="" /></span>
                <span className="avatar-studio-size is-roster" aria-hidden><img src={selected.dataUrl} alt="" /></span>
                <small>In a message and in the member list</small>
              </div>
            )}
            {candidates.length > 1 && (
              <div className="avatar-studio-strip" role="listbox" aria-label="Candidates">
                {candidates.map((candidate) => (
                  <button
                    type="button"
                    key={candidate.id}
                    className={`avatar-studio-thumb${candidate.id === selected?.id ? " selected" : ""}`}
                    title={`Drawn by ${chatCliProviderLabel(candidate.drawnBy.kind)}${candidate.drawnBy.model ? ` · ${candidate.drawnBy.model}` : ""}`}
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
              {messages.length === 0 && !busy && (
                <p className="avatar-studio-hint">
                  Ask for a picture to start — for example, <em>a red fox in a purple hoodie</em>. Then refine it in
                  words: warmer background, no laptop, make it a cat.
                </p>
              )}
              {messages.map((message) => (
                <div key={message.id} className={`avatar-studio-message is-${message.author}${message.failed ? " is-failed" : ""}`}>
                  {message.text}
                </div>
              ))}
              {busy && (
                <div className="avatar-studio-message is-runner is-busy">
                  <Loader2 size={14} className="spin" aria-hidden /> Drawing…
                </div>
              )}
            </div>

            <div className="avatar-studio-toolbar">
              <span className="avatar-studio-toolbar-label">Drawn by</span>
              <StudioSelect
                label="drawn by"
                value={providerKind}
                display={chatCliProviderLabel(providerKind)}
                options={drawingProviders.map((kind) => ({ value: kind, label: chatCliProviderLabel(kind) }))}
                disabled={noDrawingProvider}
                onSelect={(value) => changeProvider(value as AvatarStudioProviderKind)}
              />
              <StudioSelect
                label="model"
                value={model}
                display={modelOptions.find((option) => option.value === model)?.label ?? "CLI default"}
                options={modelOptions}
                disabled={noDrawingProvider}
                onSelect={setModel}
              />
              <StudioSelect
                label="reasoning"
                value={reasoning}
                display={reasoningOptions.find((option) => option.value === reasoning)?.label ?? "CLI default"}
                options={reasoningOptions}
                disabled={noDrawingProvider || reasoningOptions.length <= 1}
                onSelect={setReasoning}
              />
            </div>

            <div className="avatar-studio-composer">
              <textarea
                ref={inputRef}
                value={prompt}
                rows={2}
                placeholder={noDrawingProvider ? "No CLI installed that can draw" : "Describe the avatar…"}
                data-testid="avatar-studio-prompt"
                disabled={noDrawingProvider}
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
                  <Square size={13} aria-hidden /> Stop
                </Button>
              ) : (
                <Button type="button" size="sm" disabled={!prompt.trim() || noDrawingProvider} onClick={() => void send()}>
                  <Send size={13} aria-hidden /> Send
                </Button>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="avatar-studio-footer">
          <p className="avatar-studio-note">
            {noDrawingProvider
              ? "Connect Codex CLI or Claude Code to draw an avatar."
              : `${chatCliProviderLabel(providerKind)} draws it, on your subscription.`}
          </p>
          <Button type="button" variant="ghost" onClick={() => closeStudio(false)}>Cancel</Button>
          <Button
            type="button"
            disabled={!selected || saving}
            data-testid="avatar-studio-use"
            onClick={() => void useAvatar()}
          >
            Use this avatar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A compact toolbar select: the app's menu, without the settings-table row around it. */
function StudioSelect(props: {
  label: string;
  value: string;
  display: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  onSelect: (value: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="avatar-studio-chip"
          aria-label={`Change ${props.label}`}
          disabled={props.disabled}
        >
          <span>{props.display}</span>
          <ChevronDown size={13} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="chat-app-tool-inline-menu">
        {props.options.map((option) => (
          <button
            type="button"
            key={option.value || "default"}
            className={`chat-app-tool-inline-option${option.value === props.value ? " selected" : ""}`}
            onClick={() => {
              props.onSelect(option.value);
              setOpen(false);
            }}
          >
            <span>{option.label}</span>
            {option.value === props.value && <Check size={14} aria-hidden />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

import { useEffect, useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import {
  AppSelect
} from "../primitives";
import type {
  ChatParticipantEndpoint,
  ChatProviderKind,
  ChatReasoningEffort,
  ProviderModel,
  ProviderModelCatalog,
  ProviderReasoningEffortOption
} from "../../../shared/types";
import { normalizeChatReasoningEffort, reasoningEffortOptionsForProvider } from "../../../shared/reasoningEffort";
import { chatParticipantEndpointDefaultModel, chatParticipantEndpointFor } from "../../../shared/chatParticipantEndpoint";
import { chatInheritedCliSettingLabel, chatModelDefaultLabel } from "./chat-participant-drafts";
import { useProviderModelCatalog } from "./use-provider-model-catalog";

const MODEL_DEFAULT_VALUE = "__accordagents_default_model__";
const MODEL_MANUAL_VALUE = "__accordagents_manual_model__";
const REASONING_DEFAULT_VALUE = "__accordagents_default_reasoning__";

export function ChatModelPicker(props: {
  kind: ChatProviderKind;
  endpoint?: ChatParticipantEndpoint;
  model?: string;
  onChange: (model?: string) => void;
}): JSX.Element {
  const [manualMode, setManualMode] = useState(false);
  const model = props.model?.trim() || undefined;
  const endpoint = chatParticipantEndpointFor(props.kind, props.endpoint);
  const endpointPreset = endpoint?.preset;
  const { catalog, loading, error } = useProviderModelCatalog(props.kind, endpoint);

  useEffect(() => {
    setManualMode(false);
  }, [endpointPreset, props.kind]);

  const models = useMemo(() => catalog?.models ?? [], [catalog]);
  const selectedDiscoveredModel = model ? models.some((item) => item.id === model) : false;
  const manualSelected = manualMode || Boolean(model && !selectedDiscoveredModel);
  const selectValue = manualSelected
    ? MODEL_MANUAL_VALUE
    : model
    ? selectedDiscoveredModel
      ? model
      : MODEL_MANUAL_VALUE
    : MODEL_DEFAULT_VALUE;
  const status = modelPickerStatus(catalog, loading, error);
  const cliSettingLabel = chatModelDefaultLabel(props.kind, endpoint);

  return (
    <div className="chat-model-picker">
      <AppSelect
        value={selectValue}
        placeholder={cliSettingLabel}
        ariaLabel="Member model"
        options={[
          { value: MODEL_DEFAULT_VALUE, label: cliSettingLabel },
          ...models.map((item) => ({
            value: item.id,
            label: formatModelOption(item, catalog?.authoritative === true)
          })),
          { value: MODEL_MANUAL_VALUE, label: model && !selectedDiscoveredModel ? `Manual: ${model}` : "Manual override" }
        ]}
        onValueChange={(value) => {
          if (value === MODEL_DEFAULT_VALUE) {
            setManualMode(false);
            props.onChange(undefined);
            return;
          }
          if (value === MODEL_MANUAL_VALUE) {
            setManualMode(true);
            props.onChange(model ?? "");
            return;
          }
          setManualMode(false);
          props.onChange(value);
        }}
      />
      {manualSelected && (
        <Input
          className="chat-model-picker-manual"
          value={model ?? ""}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder={endpoint ? `${chatParticipantEndpointDefaultModel(endpoint)}...` : props.kind === "claude-code" ? "opus, sonnet, haiku..." : props.kind === "gemini-cli" ? "Gemini 3.5 Flash (Medium)..." : "gpt-5.5..."}
        />
      )}
      {status && <small className="chat-model-picker-status">{status}</small>}
    </div>
  );
}

export function ChatReasoningEffortPicker(props: {
  kind: ChatProviderKind;
  endpoint?: ChatParticipantEndpoint;
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
  onChange: (reasoningEffort?: ChatReasoningEffort) => void;
}): JSX.Element {
  const selectedModel = props.model?.trim() || undefined;
  const reasoningEffort = normalizeChatReasoningEffort(props.reasoningEffort, props.kind);
  const { catalog, loading, error } = useProviderModelCatalog(props.kind, props.endpoint);

  const options = useMemo(() => {
    const modelOptions = selectedModel
      ? catalog?.models.find((item) => item.id === selectedModel)?.supportedReasoningEfforts
      : undefined;
    return modelOptions && modelOptions.length > 0 ? modelOptions : reasoningEffortOptionsForProvider(props.kind);
  }, [catalog, props.kind, selectedModel]);

  useEffect(() => {
    if (reasoningEffort && !options.some((option) => option.id === reasoningEffort)) {
      props.onChange(undefined);
    }
  }, [options, props, reasoningEffort]);

  const status = reasoningPickerStatus(loading, error, selectedModel, catalog);
  const cliSettingLabel = chatInheritedCliSettingLabel(props.kind);

  return (
    <div className="chat-reasoning-picker">
      <AppSelect
        value={reasoningEffort ?? REASONING_DEFAULT_VALUE}
        placeholder={cliSettingLabel}
        ariaLabel="Member reasoning effort"
        options={[
          { value: REASONING_DEFAULT_VALUE, label: cliSettingLabel },
          ...options.map((item) => ({
            value: item.id,
            label: formatReasoningOption(item)
          }))
        ]}
        onValueChange={(value) => {
          if (value === REASONING_DEFAULT_VALUE) {
            props.onChange(undefined);
            return;
          }
          props.onChange(normalizeChatReasoningEffort(value, props.kind));
        }}
      />
      {status && <small className="chat-model-picker-status">{status}</small>}
    </div>
  );
}

// Source tags describe how a detected catalog was assembled; an authoritative
// (fixed) catalog has nothing to explain, so only "recommended" survives there.
function formatModelOption(model: ProviderModel, authoritative = false): string {
  const tags = [
    model.recommended ? "recommended" : "",
    !authoritative && model.source === "configured" ? "configured" : "",
    !authoritative && model.source === "builtin" ? "fallback" : ""
  ].filter(Boolean);
  return `${model.label}${tags.length ? ` - ${tags.join(", ")}` : ""}`;
}

function modelPickerStatus(catalog: ProviderModelCatalog | undefined, loading: boolean, error: string | undefined): string | undefined {
  if (loading) {
    return "Detecting available models...";
  }
  if (error) {
    return "Model detection failed; use manual override.";
  }
  if (catalog?.error) {
    return catalog.models.length > 0
      ? "Using fallback models; exact detection failed."
      : "Model detection unavailable; use manual override.";
  }
  if (catalog && catalog.models.length === 0) {
    return "No models detected; use manual override.";
  }
  return undefined;
}

function formatReasoningOption(option: ProviderReasoningEffortOption): string {
  return `${option.label}${option.recommended ? " - recommended" : ""}`;
}

function reasoningPickerStatus(
  loading: boolean,
  error: string | undefined,
  selectedModel: string | undefined,
  catalog: ProviderModelCatalog | undefined
): string | undefined {
  if (loading && selectedModel) {
    return "Detecting model efforts...";
  }
  if (error && selectedModel) {
    return "Using provider effort options.";
  }
  if (selectedModel && catalog?.error) {
    return "Using provider effort options.";
  }
  return undefined;
}

import type { ChatProviderKind, ProviderModel, ProviderModelCatalog } from "../../../../shared/types";
import { dedupeProviderModels } from "./claudeModelProbe";
import { CLAUDE_EXECUTABLE_ENV } from "./constants";
import { findStringField } from "../runs/records";

export function claudeModelProbeExpectScript(spawnArguments = "--safe-mode --no-chrome"): string {
  return [
    "set timeout 8",
    "set stty_init \"rows 40 columns 120\"",
    "log_user 1",
    `spawn $env(${CLAUDE_EXECUTABLE_ENV}) ${spawnArguments}`,
    "set saw_settings_warning 0",
    "expect {",
    "  -re \"Settings.*Warning\" {",
    "    set saw_settings_warning 1",
    "    exp_continue",
    "  }",
    "  -re \"Enter.*to.*confirm\" {",
    "    if {$saw_settings_warning} {",
    "      send \"\\r\"",
    "      set saw_settings_warning 0",
    "    }",
    "    exp_continue",
    "  }",
    "  -re \"Transcript.*saving.*is.*off\" {}",
    "  timeout { exit 124 }",
    "  eof { exit 1 }",
    "}",
    "after 500",
    "send \"/model\\r\"",
    "expect {",
    "  -re \"Enter.*to.*set.*Esc.*to.*cancel\" {}",
    "  timeout { exit 124 }",
    "  eof { exit 1 }",
    "}",
    "send \"\\033\"",
    "after 250",
    "send \"/exit\\r\"",
    "set timeout 2",
    "expect {",
    "  eof {}",
    "  timeout { exit 0 }",
    "}",
    "exit 0"
  ].join("\n");
}

export function fallbackModelsForKind(kind: ChatProviderKind, platform = process.platform): ProviderModel[] {
  if (kind === "claude-code") {
    if (platform === "win32") {
      return [];
    }
    return [
      { id: "opus", label: "Opus", source: "builtin" },
      { id: "sonnet", label: "Sonnet", source: "builtin" },
      { id: "haiku", label: "Haiku", source: "builtin" }
    ];
  }
  if (kind === "gemini-cli") {
    return [
      { id: "Gemini 3.5 Flash (Medium)", label: "Gemini 3.5 Flash (Medium)", source: "builtin", recommended: true },
      { id: "Gemini 3.5 Flash (High)", label: "Gemini 3.5 Flash (High)", source: "builtin" },
      { id: "Gemini 3.5 Flash (Low)", label: "Gemini 3.5 Flash (Low)", source: "builtin" },
      { id: "Gemini 3.1 Pro (Low)", label: "Gemini 3.1 Pro (Low)", source: "builtin" },
      { id: "Gemini 3.1 Pro (High)", label: "Gemini 3.1 Pro (High)", source: "builtin" }
    ];
  }
  return [];
}

export function withConfiguredModel(catalog: ProviderModelCatalog, configuredModel?: string): ProviderModelCatalog {
  const id = configuredModel?.trim();
  if (!id || catalog.models.some((model) => model.id === id)) {
    return catalog;
  }
  return {
    ...catalog,
    models: [
      {
        id,
        label: id,
        source: "configured",
        recommended: true
      },
      ...catalog.models
    ]
  };
}

export function dedupeModels(models: ProviderModel[]): ProviderModel[] {
  return dedupeProviderModels(models);
}

export function findModelId(value: unknown): string | undefined {
  return findStringField(value, ["model", "model_id", "modelId", "resolved_model", "resolvedModel"]);
}

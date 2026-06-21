import type { AgentContextUsage, ChatRoleRuntime, ParticipantConfig, ProviderKind, ProviderModel, ProviderModelCatalog } from "../../shared/types";
import { SettingsService } from "./settings";

export interface ParticipantRunResult {
  participant: ParticipantConfig;
  content: string;
  ok: boolean;
  error?: string;
  durationMs?: number;
  sessionId?: string;
  sessionRestarted?: boolean;
  roleRuntime?: ChatRoleRuntime;
  contextUsage?: AgentContextUsage;
  warnings?: string[];
}

function textFromOpenAi(data: unknown): string {
  const response = data as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
  };
  if (response.output_text) {
    return response.output_text;
  }
  return (
    response.output
      ?.flatMap((item) => item.content ?? [])
      .map((content) => content.text)
      .filter(Boolean)
      .join("\n") ?? ""
  );
}

function assertOpenAiTextResponse(data: unknown): string {
  const response = data as {
    status?: string;
    incomplete_details?: { reason?: string };
    model?: string;
  };
  const content = textFromOpenAi(data).trim();
  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason ?? "unknown reason";
    const model = response.model ? ` from ${response.model}` : "";
    throw new Error(`OpenAI returned an incomplete response${model}: ${reason}.`);
  }
  if (!content) {
    const status = response.status ? ` Status: ${response.status}.` : "";
    const model = response.model ? ` Model: ${response.model}.` : "";
    throw new Error(`OpenAI response contained no text output.${status}${model}`);
  }
  return content;
}

function textFromAnthropic(data: unknown): string {
  const response = data as { content?: Array<{ type?: string; text?: string }> };
  return response.content?.map((block) => block.text).filter(Boolean).join("\n") ?? "";
}

function textFromGemini(data: unknown): string {
  const response = data as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return (
    response.candidates?.flatMap((candidate) => candidate.content?.parts ?? []).map((part) => part.text).filter(Boolean).join("\n") ?? ""
  );
}

function requireTextOutput(providerLabel: string, content: string): string {
  const text = content.trim();
  if (!text) {
    throw new Error(`${providerLabel} response contained no text output.`);
  }
  return text;
}

function sortModels(models: ProviderModel[]): ProviderModel[] {
  return models.sort((left, right) => {
    if (left.createdAt && right.createdAt) {
      return right.createdAt.localeCompare(left.createdAt);
    }
    return left.id.localeCompare(right.id);
  });
}

function openAiModelUsabilityScore(id: string): number {
  if (/^(gpt-|o\d|chatgpt-)/i.test(id)) {
    return 0;
  }
  if (/embedding|transcrib|tts|audio|image|dall|sora|moderation/i.test(id)) {
    return 2;
  }
  return 1;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (signal?.aborted) {
    abort();
  }
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const message = typeof json === "object" && json && "error" in json ? JSON.stringify((json as { error: unknown }).error) : text;
      throw new Error(`${response.status} ${response.statusText}: ${message}`);
    }
    return json;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(signal?.aborted ? "Request cancelled." : `Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export class ProviderRunner {
  constructor(private readonly settings: SettingsService) {}

  async listModels(kind: ProviderKind): Promise<ProviderModel[]> {
    return (await this.listModelCatalog(kind)).models;
  }

  async listModelCatalog(kind: ProviderKind): Promise<ProviderModelCatalog> {
    const fetchedAt = new Date().toISOString();
    if (kind === "openai") {
      return { kind, models: await this.listOpenAiModels(), authoritative: true, fetchedAt };
    }
    if (kind === "anthropic") {
      return { kind, models: await this.listAnthropicModels(), authoritative: true, fetchedAt };
    }
    if (kind === "gemini") {
      return { kind, models: await this.listGeminiModels(), authoritative: true, fetchedAt };
    }
    return { kind, models: [], authoritative: false, fetchedAt, error: "Model discovery is not available for this provider." };
  }

  async run(participant: ParticipantConfig, prompt: string, signal?: AbortSignal): Promise<ParticipantRunResult> {
    if (participant.kind === "openai") {
      return this.runOpenAi(participant, prompt, signal);
    }
    if (participant.kind === "anthropic") {
      return this.runAnthropic(participant, prompt, signal);
    }
    if (participant.kind === "gemini") {
      return this.runGemini(participant, prompt, signal);
    }
    return { participant, ok: false, content: "", error: `${participant.label} is not a hosted API provider.` };
  }

  private async runOpenAi(participant: ParticipantConfig, prompt: string, signal?: AbortSignal): Promise<ParticipantRunResult> {
    const startedAt = Date.now();
    try {
      const apiKey = await this.requireApiKey(participant);
      const data = await fetchJson(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: participant.model,
            input: prompt,
            max_output_tokens: 4096
          })
        },
        120_000,
        signal
      );
      return { participant, ok: true, content: assertOpenAiTextResponse(data), durationMs: Date.now() - startedAt };
    } catch (error) {
      return this.failed(participant, error, Date.now() - startedAt);
    }
  }

  private async runAnthropic(participant: ParticipantConfig, prompt: string, signal?: AbortSignal): Promise<ParticipantRunResult> {
    const startedAt = Date.now();
    try {
      const apiKey = await this.requireApiKey(participant);
      const data = await fetchJson(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: participant.model,
            max_tokens: 2048,
            messages: [{ role: "user", content: prompt }]
          })
        },
        120_000,
        signal
      );
      return { participant, ok: true, content: requireTextOutput("Anthropic", textFromAnthropic(data)), durationMs: Date.now() - startedAt };
    } catch (error) {
      return this.failed(participant, error, Date.now() - startedAt);
    }
  }

  private async runGemini(participant: ParticipantConfig, prompt: string, signal?: AbortSignal): Promise<ParticipantRunResult> {
    const startedAt = Date.now();
    try {
      const apiKey = await this.requireApiKey(participant);
      const model = encodeURIComponent(participant.model ?? "gemini-2.5-pro");
      const data = await fetchJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              maxOutputTokens: 2048
            }
          })
        },
        120_000,
        signal
      );
      return { participant, ok: true, content: requireTextOutput("Gemini", textFromGemini(data)), durationMs: Date.now() - startedAt };
    } catch (error) {
      return this.failed(participant, error, Date.now() - startedAt);
    }
  }

  private async listOpenAiModels(): Promise<ProviderModel[]> {
    const apiKey = await this.requireApiKey({ id: "openai", kind: "openai", label: "OpenAI" });
    const data = (await fetchJson(
      "https://api.openai.com/v1/models",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        }
      },
      60_000
    )) as { data?: Array<{ id: string; created?: number; owned_by?: string }> };

    return sortModels(
      (data.data ?? [])
        .filter((model) => openAiModelUsabilityScore(model.id) < 2)
        .sort((left, right) => openAiModelUsabilityScore(left.id) - openAiModelUsabilityScore(right.id))
        .map((model) => ({
          id: model.id,
          label: model.id,
          description: model.owned_by ? `Owner: ${model.owned_by}` : undefined,
          createdAt: model.created ? new Date(model.created * 1000).toISOString() : undefined,
          source: "provider-api" as const
        }))
    );
  }

  private async listAnthropicModels(): Promise<ProviderModel[]> {
    const apiKey = await this.requireApiKey({ id: "anthropic", kind: "anthropic", label: "Anthropic" });
    const data = (await fetchJson(
      "https://api.anthropic.com/v1/models?limit=1000",
      {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json"
        }
      },
      60_000
    )) as { data?: Array<{ id: string; display_name?: string; created_at?: string }> };

    return sortModels(
      (data.data ?? []).map((model) => ({
        id: model.id,
        label: model.display_name ? `${model.display_name} (${model.id})` : model.id,
        createdAt: model.created_at,
        source: "provider-api" as const
      }))
    );
  }

  private async listGeminiModels(): Promise<ProviderModel[]> {
    const apiKey = await this.requireApiKey({ id: "gemini", kind: "gemini", label: "Gemini" });
    const models: ProviderModel[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({ key: apiKey, pageSize: "1000" });
      if (pageToken) {
        params.set("pageToken", pageToken);
      }
      const data = (await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models?${params.toString()}`, { method: "GET" }, 60_000)) as {
        models?: Array<{
          name: string;
          displayName?: string;
          description?: string;
          supportedGenerationMethods?: string[];
        }>;
        nextPageToken?: string;
      };

      for (const model of data.models ?? []) {
        if (model.supportedGenerationMethods && !model.supportedGenerationMethods.includes("generateContent")) {
          continue;
        }
        const id = model.name.replace(/^models\//, "");
        models.push({
          id,
          label: model.displayName ? `${model.displayName} (${id})` : id,
          description: model.description,
          source: "provider-api"
        });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);

    return sortModels(models);
  }

  private async requireApiKey(participant: ParticipantConfig): Promise<string> {
    const apiKey = await this.settings.getApiKey(participant.kind);
    if (!apiKey) {
      throw new Error(`No API key saved for ${participant.label}.`);
    }
    return apiKey;
  }

  private failed(participant: ParticipantConfig, error: unknown, durationMs?: number): ParticipantRunResult {
    const message = error instanceof Error ? error.message : String(error);
    return {
      participant,
      ok: false,
      content: `${participant.label} failed: ${message}`,
      error: message,
      durationMs
    };
  }
}

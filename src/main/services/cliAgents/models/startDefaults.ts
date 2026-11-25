import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ChatProviderKind, ProviderModel } from "../../../../shared/types";
import { commandEnvironment } from "../../command";
import { geminiUserSettingsPath } from "../../geminiExec";
import { stripAnsi } from "./claudeModelProbe";

/** The User's own config file of a CLI (where its start defaults come
 *  from), as its size and change time: Codex's config.toml, Claude Code's
 *  settings.json, agy's settings.json. */
export async function cliConfigStamp(kind: ChatProviderKind): Promise<string> {
  const env = commandEnvironment();
  const file = kind === "codex-cli"
    ? path.join(env.CODEX_HOME?.trim() || path.join(homedir(), ".codex"), "config.toml")
    : kind === "claude-code"
      ? path.join(env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), ".claude"), "settings.json")
      : geminiUserSettingsPath(homedir());
  try {
    const info = await stat(file);
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return "none";
  }
}

export function textField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * A CLI's model list with the model it runs when none is chosen marked
 * (`recommended`): the one the User's own config names (Codex's
 * config.toml `model`, the model Claude Code says it applies), listed or not
 * (a model the list leaves out is put first by its id); the list as the CLI
 * marked it when the config names none.
 */
export function withCliStartModel(models: readonly ProviderModel[], startModel: string | undefined, matches?: (model: ProviderModel) => boolean): ProviderModel[] {
  const id = startModel?.trim();
  if (!id) return [...models];
  const isStart = matches ?? ((model: ProviderModel) => model.id === id);
  const index = models.findIndex((model) => isStart(model));
  if (index < 0) {
    return [{ id, label: id, source: "cli", recommended: true }, ...models.map((model) => model.recommended ? { ...model, recommended: false } : model)];
  }
  return models.map((model, position) => position === index
    ? (model.recommended ? model : { ...model, recommended: true })
    : (model.recommended ? { ...model, recommended: false } : model));
}

/** `agy models` prints `<id>\t<label>` per line (seen on agy 1.5.11;
 *  earlier versions printed the label alone). `--model` takes the id. */
export function parseAgyModelList(stdout: string): ProviderModel[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trim())
    .filter((line) => line && !/^(available|usage|error|fetching)\b/i.test(line))
    .map((line, index) => {
      const [first, ...rest] = line.split("\t");
      const id = first.trim();
      const label = rest.join(" ").trim() || id;
      return {
        id,
        label,
        source: "cli" as const,
        // `agy models` lists the currently selected default first.
        recommended: index === 0
      };
    })
    .filter((model) => model.id);
}

/** `agy models` as the dedicated CLI runs it: on the sign-in, or on a Gemini
 *  API key (its settings on the command line, the key only in the env). */
export function agyModelsInvocation(
  apiKey?: { env: Record<string, string>; settings: Readonly<Record<string, unknown>> }
): { args: string[]; env: Record<string, string> } {
  return apiKey
    ? { args: ["--settings", JSON.stringify(apiKey.settings), "models"], env: { ...apiKey.env } }
    : { args: ["models"], env: {} };
}

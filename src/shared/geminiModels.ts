import type { ChatProviderKind } from "./types";

/** The model id agy takes for `--model`. `agy models` prints `<id>\t<label>`
 *  (agy 1.5.x); a model picked while the app read that whole line as the id
 *  was saved with the label attached, and agy refuses that, so only the id
 *  counts. */
export function geminiModelId(model: string | undefined): string | undefined {
  const id = model?.split("\t")[0]?.trim();
  return id || undefined;
}

/** A member's saved model as its pickers compare it with the CLI's list. */
export function savedModelId(kind: ChatProviderKind, model: string | undefined): string | undefined {
  return kind === "gemini-cli" ? geminiModelId(model) : model?.trim() || undefined;
}

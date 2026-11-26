import { EMBEDDING_DIMS, EMBEDDING_MODEL } from "./semanticVectors";

export const OPENAI_BASE_URL = "https://api.openai.com";
/** Inputs in one request (OpenAI takes up to 2048; fewer keep a failure small). */
export const EMBED_BATCH_INPUTS = 96;

/** Why OpenAI did not give prints: the key (stop until it changes), too
 *  many requests (wait), a bad input (skip it), or anything else (retry). */
export type EmbeddingFailureKind = "key" | "rate" | "input" | "other";

export class EmbeddingError extends Error {
  constructor(message: string, readonly kind: EmbeddingFailureKind, readonly retryAfterMs?: number) {
    super(message);
    this.name = "EmbeddingError";
  }
}

/** Prints of meaning from OpenAI, with the User's key. The key never leaves
 *  this object but in the request's Authorization header. */
export class OpenAiEmbeddings {
  constructor(
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = OPENAI_BASE_URL
  ) {}

  /** One print per text, in order. */
  async embed(texts: string[], timeoutMs: number, cancel?: AbortSignal): Promise<number[][]> {
    if (!texts.length) return [];
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const onCancel = () => abort.abort();
    cancel?.addEventListener("abort", onCancel, { once: true });
    if (cancel?.aborted) abort.abort();
    let response: Response;
    let body: { data?: Array<{ index?: unknown; embedding?: unknown }>; error?: { message?: unknown; code?: unknown; type?: unknown } } | undefined;
    // The time limit and the cancel cover the answer's body too: one that
    // stops half way never holds printing (or the server's closing) up.
    try {
      try {
        response = await this.fetchImpl(`${this.baseUrl}/v1/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
          body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts, dimensions: EMBEDDING_DIMS }),
          signal: abort.signal
        });
      } catch (error) {
        throw new EmbeddingError(abort.signal.aborted ? "OpenAI did not answer in time." : `OpenAI could not be reached (${messageOf(error)}).`, "other");
      }
      // Raced with the limit, not left to the connection to give up.
      body = await Promise.race([
        response.json().catch(() => undefined) as Promise<typeof body>,
        new Promise<undefined>((resolve) => {
          if (abort.signal.aborted) resolve(undefined);
          abort.signal.addEventListener("abort", () => resolve(undefined), { once: true });
        })
      ]);
      if (abort.signal.aborted) throw new EmbeddingError("OpenAI did not answer in time.", "other");
    } finally {
      clearTimeout(timer);
      cancel?.removeEventListener("abort", onCancel);
    }
    if (!response.ok) {
      const said = typeof body?.error?.message === "string" ? body.error.message.slice(0, 200) : `HTTP ${response.status}`;
      // Never repeats the key: OpenAI's message for a wrong key shows its end.
      const reason = said.replace(/sk-[A-Za-z0-9_*-]{4,}/g, "sk-…");
      if (response.status === 401 || response.status === 403) throw new EmbeddingError(`OpenAI refused the key (${reason}).`, "key");
      if (response.status === 429) {
        // No credit left is said by its code; a rate limit's message may name a quota too.
        if (body?.error?.code === "insufficient_quota" || body?.error?.type === "insufficient_quota") throw new EmbeddingError(`OpenAI says the account has no credit left (${reason}).`, "key");
        throw new EmbeddingError(`OpenAI asked to slow down (${reason}).`, "rate", retryAfter(response.headers.get("retry-after")));
      }
      if (response.status === 400) throw new EmbeddingError(`OpenAI could not print this text (${reason}).`, "input");
      throw new EmbeddingError(`OpenAI could not answer (${reason}).`, "other");
    }
    const data = Array.isArray(body?.data) ? body.data : [];
    const prints: number[][] = new Array(texts.length);
    for (const item of data) {
      if (typeof item.index === "number" && Array.isArray(item.embedding) && item.index >= 0 && item.index < texts.length) {
        prints[item.index] = item.embedding as number[];
      }
    }
    for (let index = 0; index < texts.length; index += 1) {
      if (!prints[index] || prints[index].length !== EMBEDDING_DIMS) throw new EmbeddingError("OpenAI's answer was incomplete.", "other");
    }
    return prints;
  }
}

function retryAfter(header: string | null): number | undefined {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 300) * 1000 : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
}

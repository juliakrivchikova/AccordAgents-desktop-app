import type { ArtifactError, ArtifactResult, CreateArtifactRequest } from "../../../shared/types";

export function ok<T>(value: T): ArtifactResult<T> {
  return { ok: true, value };
}

export function fail<T>(error: ArtifactError): ArtifactResult<T> {
  return { ok: false, error };
}

export function invalid<T>(message: string): ArtifactResult<T> {
  return fail<T>({ code: "invalid_request", message });
}

/** A create request that mixes the two lifecycles' fields is refused, not
 *  silently trimmed. A field present with no value counts as present (as an
 *  in-process caller sees it), so this is checked before a request travels. */
export function artifactCreateMixedFieldError(request: CreateArtifactRequest): string | undefined {
  const input = request as unknown as Record<string, unknown>;
  const forbidden = request.initialState === "collecting_drafts"
    ? ["content", "note", "requiredSigners"]
    : ["allowedDraftAuthors", "requiredDraftAuthors", "audiencePolicyByAuthor", "operationId"];
  const mixedField = forbidden.find((field) => Object.prototype.hasOwnProperty.call(input, field));
  return mixedField ? `Field "${mixedField}" is not valid for initialState "${request.initialState ?? "published"}".` : undefined;
}

export const SUBMIT_OWN_DRAFT_FIRST_MESSAGE =
  "Submit your own draft to this collection before reading other authors' drafts.";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

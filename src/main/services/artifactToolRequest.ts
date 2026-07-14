export function validateArtifactCreateToolRequest(args: Record<string, unknown>): string | undefined {
  const initialState = args.initialState;
  if (initialState !== undefined && initialState !== "published" && initialState !== "collecting_drafts") {
    return 'initialState must be "published" or "collecting_drafts".';
  }
  const forbidden = initialState === "collecting_drafts"
    ? ["content", "note", "requiredSigners"]
    : ["allowedDraftAuthors", "requiredDraftAuthors", "audiencePolicyByAuthor", "operationId"];
  const mixedField = forbidden.find((field) => Object.prototype.hasOwnProperty.call(args, field));
  return mixedField
    ? `Field "${mixedField}" is not valid for initialState "${initialState ?? "published"}".`
    : undefined;
}

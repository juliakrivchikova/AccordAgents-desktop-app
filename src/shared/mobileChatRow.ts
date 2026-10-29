/** How the phone's chat list names a chat's group and its last words; the
 *  phone uses the same for a chat it started, until the server lists it. */
export function mobileChatGroupLabel(repoPath: string | undefined): string {
  if (!repoPath) {
    return "AccordAgents";
  }
  const parts = repoPath.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || "AccordAgents";
}

export function mobileSnippet(content: string | undefined): string {
  const normalized = content?.replace(/\s+/g, " ").trim() ?? "";
  if (!normalized) {
    return "No messages yet";
  }
  return normalized.length > 84 ? `${normalized.slice(0, 81)}...` : normalized;
}

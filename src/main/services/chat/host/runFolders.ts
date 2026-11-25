/** What a member says when its project folder is gone. */
export function missingRunFolderText(handle: string, missing: { reason: string; machineCopy: boolean }): string {
  return `@${handle} could not start: ${missing.reason}.${missing.machineCopy ? " Send the message again from your computer to copy the project there again." : ""}`;
}

/** A process that could not start in its folder (Node names the missing
 *  folder as a missing executable). */
export function startFailedOnMissingPath(result: { error?: string; content?: string }): boolean {
  return /\bENOENT\b|no such file or directory|not a directory/i.test(`${result.error ?? ""}\n${result.content ?? ""}`);
}

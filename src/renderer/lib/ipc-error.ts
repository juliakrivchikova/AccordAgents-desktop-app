/** An error's message without Electron's "Error invoking remote method '…': Error: " prefix. */
export function cleanIpcError(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

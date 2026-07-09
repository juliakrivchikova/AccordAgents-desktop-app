export type ClipboardWriteResult = "copied" | "failed";

export async function writeClipboardText(
  text: string,
  writeText: (value: string) => Promise<void>
): Promise<ClipboardWriteResult> {
  try {
    await writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}

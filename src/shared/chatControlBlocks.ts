// What the desktop hides from a member's message and shows as its own control
// instead: the `User choice:` block the chat turns into a card, and an empty
// `Participant requests:` list. Shared because the phone shows the same
// message — the rule lived in the desktop renderer alone, so the PWA printed
// the raw block above the very card built from it (the User, 2026-09-20).
export function stripChatControlBlocks(content: string): string {
  return stripUserChoiceBlocks(stripNoParticipantRequests(content)).trimEnd();
}

function stripNoParticipantRequests(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const next: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (/^participant requests\s*:\s*none\.?$/i.test(trimmed)) {
      continue;
    }
    if (/^participant requests\s*:\s*$/i.test(trimmed)) {
      const following = lines[index + 1]?.trim();
      if (following && /^(?:[-*]|\d+[.)])\s+none\.?$/i.test(following)) {
        index += 1;
        continue;
      }
    }
    next.push(line);
  }
  return next.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function stripUserChoiceBlocks(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const nextLines: string[] = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      nextLines.push(lines[index]);
      continue;
    }
    if (inFence || !/^user choice\s*:/i.test(trimmed)) {
      nextLines.push(lines[index]);
      continue;
    }
    for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
      const blockTrimmed = lines[blockIndex].trim();
      if (!blockTrimmed) {
        index = blockIndex;
        continue;
      }
      if (isUserChoiceDisplayProtocolLine(blockTrimmed)) {
        index = blockIndex;
        continue;
      }
      break;
    }
  }
  return nextLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function isUserChoiceDisplayProtocolLine(line: string): boolean {
  const normalized = line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim();
  return /^(?:T|TITLE|Q|QUESTION|R|RECOMMENDED|O\d+)\s*[:|]/i.test(normalized);
}

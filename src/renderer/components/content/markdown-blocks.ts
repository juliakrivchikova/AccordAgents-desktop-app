export type MarkdownBlock =
  | { type: "paragraph"; lines: string[] }
  | { type: "heading"; text: string }
  | { type: "code"; content: string; language?: string }
  | { type: "ul"; items: string[]; indent: number }
  | { type: "ol"; items: string[]; start?: number; indent: number }
  | { type: "table"; headers: string[]; rows: string[][] };

export function markdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^```(\S*)/);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({ type: "code", language: fence[1] || undefined, content: codeLines.join("\n") });
      continue;
    }

    const heading = trimmed.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      blocks.push({ type: "heading", text: heading[1].trim() });
      index += 1;
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      const headers = parseMarkdownTableRow(lines[index]);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && isMarkdownTableRow(lines[index])) {
        rows.push(normalizeMarkdownTableRow(parseMarkdownTableRow(lines[index]), headers.length));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    const listMatch = line.match(/^(\s*)(?:([-*])|(\d+)[.)])\s+(.+)$/);
    if (listMatch) {
      const indent = markdownIndent(listMatch[1]);
      const ordered = Boolean(listMatch[3]);
      const start = ordered ? Number.parseInt(listMatch[3], 10) : undefined;
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index];
        const match = current.match(/^(\s*)(?:([-*])|(\d+)[.)])\s+(.+)$/);
        if (!match || Boolean(match[3]) !== ordered || markdownIndent(match[1]) !== indent) {
          break;
        }
        items.push(match[4].trim());
        index += 1;
      }
      blocks.push(ordered ? { type: "ol", items, start, indent } : { type: "ul", items, indent });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const current = lines[index];
      const currentTrimmed = current.trim();
      if (
        !currentTrimmed ||
        currentTrimmed.startsWith("```") ||
        /^#{1,3}\s+/.test(currentTrimmed) ||
        isMarkdownTableStart(lines, index) ||
        /^\s*(?:[-*]|\d+[.)])\s+/.test(current)
      ) {
        break;
      }
      paragraphLines.push(current);
      index += 1;
    }
    blocks.push({ type: "paragraph", lines: paragraphLines });
  }

  return normalizeOrderedListStarts(blocks);
}

function normalizeOrderedListStarts(blocks: MarkdownBlock[]): MarkdownBlock[] {
  const nextOrderedStarts = new Map<number, number>();
  const continuableOrderedIndents = new Set<number>();

  return blocks.map((block) => {
    if (block.type === "heading") {
      nextOrderedStarts.clear();
      continuableOrderedIndents.clear();
      return block;
    }

    if (block.type === "ol") {
      const requestedStart = block.start ?? 1;
      const nextStart = nextOrderedStarts.get(block.indent);
      const start = continuableOrderedIndents.has(block.indent) && requestedStart === 1 && nextStart !== undefined ? nextStart : requestedStart;
      nextOrderedStarts.set(block.indent, start + block.items.length);
      continuableOrderedIndents.add(block.indent);
      return { ...block, start };
    }

    if (block.type !== "ul") {
      nextOrderedStarts.clear();
      continuableOrderedIndents.clear();
    }

    return block;
  });
}

function markdownIndent(value: string): number {
  return value.replace(/\t/g, "    ").length;
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length || !isMarkdownTableRow(lines[index])) {
    return false;
  }
  const headers = parseMarkdownTableRow(lines[index]);
  if (headers.length < 2) {
    return false;
  }
  const separator = parseMarkdownTableRow(lines[index + 1]);
  return separator.length === headers.length && separator.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && parseMarkdownTableRow(line).length > 1;
}

function parseMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim();
  const content = trimmed.startsWith("|") && trimmed.endsWith("|") ? trimmed.slice(1, -1) : trimmed;
  const cells: string[] = [];
  let current = "";

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === "\\" && content[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (character === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

function normalizeMarkdownTableRow(row: string[], columnCount: number): string[] {
  if (row.length === columnCount) {
    return row;
  }
  if (row.length > columnCount) {
    return row.slice(0, columnCount);
  }
  return [...row, ...Array.from({ length: columnCount - row.length }, () => "")];
}

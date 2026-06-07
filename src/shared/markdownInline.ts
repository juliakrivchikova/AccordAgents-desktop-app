export type MarkdownInlineNode =
  | { type: "text"; text: string }
  | { type: "strong"; children: MarkdownInlineNode[] }
  | { type: "code"; text: string }
  | { type: "messageLink"; messageId: string; label?: string }
  | { type: "externalLink"; url: string; label: string };

const MESSAGE_LINK_RE = /^\[([^\]\n]+)\]\(#msg:([0-9a-fA-F][0-9a-fA-F-]{5,})\)/;
const BARE_MESSAGE_RE = /^#msg:([0-9a-fA-F][0-9a-fA-F-]{5,})/;
const MARKDOWN_EXTERNAL_LINK_RE = /^\[([^\]\n]+)\]\((https?:\/\/[^\s<>)]+)\)/i;
const BARE_EXTERNAL_URL_RE = /^https?:\/\/[^\s<>]+/i;

export function parseMarkdownInline(text: string): MarkdownInlineNode[] {
  const nodes: MarkdownInlineNode[] = [];
  let index = 0;

  while (index < text.length) {
    if (text.startsWith("**", index)) {
      const end = text.indexOf("**", index + 2);
      if (end > index + 2) {
        nodes.push({ type: "strong", children: parseMarkdownInline(text.slice(index + 2, end)) });
        index = end + 2;
        continue;
      }
    }

    if (text[index] === "`") {
      const end = text.indexOf("`", index + 1);
      if (end > index + 1) {
        nodes.push({ type: "code", text: text.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }

    if (text[index] === "[") {
      const link = text.slice(index).match(MESSAGE_LINK_RE);
      if (link) {
        nodes.push({ type: "messageLink", messageId: link[2], label: link[1] });
        index += link[0].length;
        continue;
      }
      const externalLink = text.slice(index).match(MARKDOWN_EXTERNAL_LINK_RE);
      if (externalLink) {
        nodes.push({ type: "externalLink", url: externalLink[2], label: externalLink[1] });
        index += externalLink[0].length;
        continue;
      }
    }

    if (text[index] === "#") {
      const bare = text.slice(index).match(BARE_MESSAGE_RE);
      if (bare) {
        nodes.push({ type: "messageLink", messageId: bare[1] });
        index += bare[0].length;
        continue;
      }
    }

    const bareExternal = text.slice(index).match(BARE_EXTERNAL_URL_RE);
    if (bareExternal) {
      const { url, suffix } = splitBareExternalUrl(bareExternal[0]);
      if (url) {
        nodes.push({ type: "externalLink", url, label: url });
      }
      if (suffix) {
        nodes.push({ type: "text", text: suffix });
      }
      index += bareExternal[0].length;
      continue;
    }

    const nextBold = text.indexOf("**", index + 1);
    const nextCode = text.indexOf("`", index + 1);
    const nextLink = text.indexOf("[", index + 1);
    const nextBare = text.indexOf("#msg:", index + 1);
    const nextExternal = nextExternalUrlStart(text, index + 1);
    const nextCandidates = [nextBold, nextCode, nextLink, nextBare, nextExternal].filter((candidate) => candidate > -1);
    const next = nextCandidates.length ? Math.min(...nextCandidates) : text.length;
    nodes.push({ type: "text", text: text.slice(index, next) });
    index = next;
  }

  return mergeAdjacentTextNodes(nodes);
}

export function nextExternalUrlStart(text: string, start: number): number {
  const lowerText = text.toLowerCase();
  const nextHttp = lowerText.indexOf("http://", start);
  const nextHttps = lowerText.indexOf("https://", start);
  const candidates = [nextHttp, nextHttps].filter((candidate) => candidate > -1);
  return candidates.length ? Math.min(...candidates) : -1;
}

function splitBareExternalUrl(value: string): { url: string; suffix: string } {
  let url = value;
  let suffix = "";
  while (url && shouldTrimBareExternalUrlSuffix(url)) {
    suffix = url[url.length - 1] + suffix;
    url = url.slice(0, -1);
  }
  return { url, suffix };
}

function shouldTrimBareExternalUrlSuffix(url: string): boolean {
  const last = url[url.length - 1];
  if (".,;:!?\"'>".includes(last)) {
    return true;
  }
  if (last === ")" && countCharacter(url, ")") > countCharacter(url, "(")) {
    return true;
  }
  if (last === "]" && countCharacter(url, "]") > countCharacter(url, "[")) {
    return true;
  }
  return last === "}" && countCharacter(url, "}") > countCharacter(url, "{");
}

function countCharacter(value: string, character: string): number {
  let count = 0;
  for (const current of value) {
    if (current === character) {
      count += 1;
    }
  }
  return count;
}

function mergeAdjacentTextNodes(nodes: MarkdownInlineNode[]): MarkdownInlineNode[] {
  return nodes.reduce<MarkdownInlineNode[]>((merged, node) => {
    const previous = merged[merged.length - 1];
    if (previous?.type === "text" && node.type === "text") {
      previous.text += node.text;
      return merged;
    }
    merged.push(node);
    return merged;
  }, []);
}

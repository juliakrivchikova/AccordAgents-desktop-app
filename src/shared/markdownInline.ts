export type MarkdownInlineNode =
  | { type: "text"; text: string }
  | { type: "strong"; children: MarkdownInlineNode[] }
  | { type: "code"; text: string }
  | { type: "mention"; handle: string }
  | { type: "messageLink"; messageId: string; label?: string }
  | { type: "artifactLink"; artifactId: string; label?: string }
  | { type: "fileLink"; path: string; label: string; line?: number; column?: number }
  | { type: "externalLink"; url: string; label: string };

export interface FileLinkTarget {
  path: string;
  line?: number;
  column?: number;
}

const MESSAGE_ID_RE_SOURCE = "[A-Za-z0-9][A-Za-z0-9_-]*";
const MESSAGE_LINK_RE = new RegExp(`^\\[([^\\]\\n]+)\\]\\(#msg:(${MESSAGE_ID_RE_SOURCE})\\)`);
const BARE_MESSAGE_RE = new RegExp(`^#msg:(${MESSAGE_ID_RE_SOURCE})`);
// Artifact references: `[label](#artifact:<id>)` or bare `#artifact:<id>`. The id
// is the artifact's stable identity; the renderer shows the artifact's CURRENT
// name, so renames never break or redirect existing references.
const ARTIFACT_LINK_RE = new RegExp(`^\\[([^\\]\\n]+)\\]\\(#artifact:(${MESSAGE_ID_RE_SOURCE})\\)`);
const BARE_ARTIFACT_RE = new RegExp(`^#artifact:(${MESSAGE_ID_RE_SOURCE})`);
const MARKDOWN_EXTERNAL_LINK_RE = /^\[([^\]\n]+)\]\((https?:\/\/[^\s<>)]+)\)/i;
const MARKDOWN_FILE_LINK_RE = /^\[([^\]\n]+)\]\((<[^>\n]+>|[^)\s]+)\)/;
const BARE_EXTERNAL_URL_RE = /^https?:\/\/[^\s<>]+/i;
const FILE_LINE_SUFFIX_RE = /:(\d+)(?::(\d+))?$/;
const INLINE_CODE_GLOB_RE = /[*?]/;
const INLINE_CODE_FILE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cfg",
  "cjs",
  "cpp",
  "css",
  "cts",
  "dart",
  "ex",
  "exs",
  "go",
  "gradle",
  "h",
  "hpp",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "lock",
  "lua",
  "mjs",
  "md",
  "mts",
  "php",
  "proto",
  "py",
  "rb",
  "rs",
  "scala",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "tf",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml"
]);
// Mirrors the backend handle charset in chat.ts (extractMentions), but only at a word
// boundary so email local-parts like `user@example.com` are not treated as mentions.
const MENTION_RE = /^@([A-Za-z0-9][A-Za-z0-9_-]{0,31})/;

function isMentionBoundary(previous: string): boolean {
  return previous === "" || !/[A-Za-z0-9_]/.test(previous);
}

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
      const artifactLink = text.slice(index).match(ARTIFACT_LINK_RE);
      if (artifactLink) {
        nodes.push({ type: "artifactLink", artifactId: artifactLink[2], label: artifactLink[1] });
        index += artifactLink[0].length;
        continue;
      }
      const fileLink = text.slice(index).match(MARKDOWN_FILE_LINK_RE);
      if (fileLink) {
        const target = parseFileLinkTarget(fileLink[2]);
        if (target) {
          nodes.push({ type: "fileLink", label: fileLink[1], ...target });
          index += fileLink[0].length;
          continue;
        }
      }
      const externalLink = text.slice(index).match(MARKDOWN_EXTERNAL_LINK_RE);
      if (externalLink) {
        nodes.push({ type: "externalLink", url: externalLink[2], label: externalLink[1] });
        index += externalLink[0].length;
        continue;
      }
    }

    if (text[index] === "@" && isMentionBoundary(index > 0 ? text[index - 1] : "")) {
      const mention = text.slice(index).match(MENTION_RE);
      if (mention) {
        nodes.push({ type: "mention", handle: mention[1] });
        index += mention[0].length;
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
      const bareArtifact = text.slice(index).match(BARE_ARTIFACT_RE);
      if (bareArtifact) {
        nodes.push({ type: "artifactLink", artifactId: bareArtifact[1] });
        index += bareArtifact[0].length;
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
    const nextBareArtifact = text.indexOf("#artifact:", index + 1);
    const nextMention = text.indexOf("@", index + 1);
    const nextExternal = nextExternalUrlStart(text, index + 1);
    const nextCandidates = [nextBold, nextCode, nextLink, nextBare, nextBareArtifact, nextMention, nextExternal].filter((candidate) => candidate > -1);
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

export function parseFileLinkTarget(rawTarget: string): FileLinkTarget | undefined {
  const unwrapped = rawTarget.startsWith("<") && rawTarget.endsWith(">")
    ? rawTarget.slice(1, -1)
    : rawTarget;
  const target = unwrapped.trim();
  if (
    !target ||
    /[\0\r\n\t]/.test(target) ||
    target.startsWith("#") ||
    /^https?:\/\//i.test(target) ||
    /^mailto:/i.test(target)
  ) {
    return undefined;
  }

  const parsed = parseTargetWithLineSuffix(target);
  if (!parsed || !isPathLikeFileTarget(parsed.path)) {
    return undefined;
  }

  return parsed;
}

export function parseInlineCodeFileLinkTarget(rawTarget: string): FileLinkTarget | undefined {
  const target = rawTarget.trim();
  if (
    !target ||
    /[\0\r\n\t\s]/.test(target) ||
    target.includes("\\") ||
    INLINE_CODE_GLOB_RE.test(target) ||
    target.startsWith("#") ||
    /^https?:\/\//i.test(target) ||
    /^mailto:/i.test(target)
  ) {
    return undefined;
  }

  const parsed = parseTargetWithLineSuffix(target);
  if (!parsed || !hasSlashPathSignal(parsed.path) || !hasInlineCodeFileExtension(parsed.path)) {
    return undefined;
  }

  return parsed;
}

function parseTargetWithLineSuffix(target: string): FileLinkTarget | undefined {
  let path = target;
  let line: number | undefined;
  let column: number | undefined;
  const suffix = path.match(FILE_LINE_SUFFIX_RE);
  if (suffix) {
    line = Number.parseInt(suffix[1], 10);
    column = suffix[2] ? Number.parseInt(suffix[2], 10) : undefined;
    path = path.slice(0, -suffix[0].length);
    if (line < 1 || (column !== undefined && column < 1)) {
      return undefined;
    }
  }

  if (!path) {
    return undefined;
  }

  const parsed: FileLinkTarget = { path };
  if (line !== undefined) {
    parsed.line = line;
  }
  if (column !== undefined) {
    parsed.column = column;
  }
  return parsed;
}

function isPathLikeFileTarget(target: string): boolean {
  if (!target || target.includes("\\")) {
    return false;
  }
  if (target.startsWith("/") || target.startsWith("./") || target.startsWith("../")) {
    return true;
  }
  if (target.includes("/")) {
    return true;
  }
  return /\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(target);
}

function hasSlashPathSignal(target: string): boolean {
  return target.startsWith("/") || target.startsWith("./") || target.startsWith("../") || target.includes("/");
}

function hasInlineCodeFileExtension(target: string): boolean {
  const basename = target.split("/").pop() ?? "";
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex < 1 || dotIndex === basename.length - 1) {
    return false;
  }
  return INLINE_CODE_FILE_EXTENSIONS.has(basename.slice(dotIndex + 1).toLowerCase());
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

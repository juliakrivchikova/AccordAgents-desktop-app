export const PLUGIN_ICON_SPACER = "\u2003\u2009";

const PLUGIN_ICON_SPACER_CHARACTERS = "\u2003\u2009";
const ACTIVE_SLASH_RE = /(?:^|\s)\/([A-Za-z0-9_-]*)$/;

export function replaceActivePluginMention(value: string, pluginName: string): string {
  return replaceActiveSlashQuery(value, `${PLUGIN_ICON_SPACER}/${pluginName} `);
}

export function replaceActiveSlashQuery(value: string, insertion: string): string {
  const match = value.match(ACTIVE_SLASH_RE);
  if (!match || match.index === undefined) {
    return `${value}${value.endsWith(" ") || !value ? "" : " "}${insertion}`;
  }
  const hasPluginSpacer = match.index >= PLUGIN_ICON_SPACER.length - 1 &&
    value.slice(match.index - PLUGIN_ICON_SPACER.length + 1, match.index + 1) === PLUGIN_ICON_SPACER;
  const replacementStart = hasPluginSpacer ? match.index - PLUGIN_ICON_SPACER.length + 1 : match.index;
  const prefix = value.slice(0, replacementStart);
  const leadingSpace = !hasPluginSpacer && match[0].startsWith(" ") ? " " : "";
  return `${prefix}${leadingSpace}${insertion}`;
}

export function normalizePluginIconSpacers(value: string, pluginNames: readonly string[]): string {
  if (!value.includes(PLUGIN_ICON_SPACER)) {
    return value;
  }
  const names = new Set(pluginNames);
  return value.split(PLUGIN_ICON_SPACER).map((part, index) => {
    if (index === 0) {
      return part;
    }
    const token = part.match(/^\/([A-Za-z0-9_-]+)(?=\s|$)/)?.[1];
    return token && names.has(token) ? `${PLUGIN_ICON_SPACER}${part}` : part;
  }).join("");
}

export function stripPluginIconMetadata(value: string): string {
  const spacerRun = new RegExp(`[${PLUGIN_ICON_SPACER_CHARACTERS}]+(?=\\/[A-Za-z0-9_-]+(?:\\s|$))`, "g");
  return value.replace(spacerRun, "").split(PLUGIN_ICON_SPACER).join("");
}

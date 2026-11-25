
export function isSensitiveConfigKey(key: string): boolean {
  return /(?:^|_)(?:api_?key|authorization|bearer|credential|password|secret|token)(?:$|_)/i.test(key);
}

export function isPortableEnvironmentReference(value: string): boolean {
  const normalized = value.trim().replace(/^['"]|['"]$/g, "");
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(normalized) ||
    /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(normalized);
}

export function containsMachineSpecificPath(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsMachineSpecificPath);
  }
  if (isRecord(value)) {
    return Object.values(value).some(containsMachineSpecificPath);
  }
  if (typeof value !== "string") {
    return false;
  }
  return /(?:^|["'\s=])\/(?!usr\/bin\/env(?:["'\s]|$))/.test(value) ||
    /(?:^|["'\s=])[A-Za-z]:[\\/]/.test(value) ||
    /(?:^|["'\s=])(?:~\/|\.\.?\/)/.test(value) ||
    /\.app\/Contents\//.test(value);
}

export function containsEmbeddedSecret(value: string): boolean {
  return /https?:\/\/[^/"'\s]+:[^@/"'\s]+@/i.test(value) ||
    /(?:bearer\s+[A-Za-z0-9]|(?:api[_-]?key|password|secret|token)[=:]\s*["']?(?!\$\{?)[^\s"'}]+)/i.test(value) ||
    /--(?:api[_-]?key|password|secret|token)(?:=|["'\s])/i.test(value) ||
    /\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|AKIA[A-Z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/.test(value);
}

export function containsEmbeddedSecretValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (
        typeof item === "string" &&
        /^--(?:api[_-]?key|password|secret|token)$/i.test(item) &&
        typeof value[index + 1] === "string" &&
        !isPortableEnvironmentReference(value[index + 1] as string)
      ) {
        return true;
      }
      if (containsEmbeddedSecretValue(item)) {
        return true;
      }
    }
    return false;
  }
  if (isRecord(value)) {
    return Object.values(value).some(containsEmbeddedSecretValue);
  }
  return typeof value === "string" &&
    !isPortableEnvironmentReference(value) &&
    containsEmbeddedSecret(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

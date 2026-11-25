const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function sqlString(value: string | undefined | null): string {
  if (value === undefined || value === null) {
    return "NULL";
  }
  // The sqlite3 shell reads statements line by line and a NUL ends a line:
  // the rest of the literal would leak into the statement.
  if (value.includes("\u0000")) {
    throw new Error("A value with a NUL character cannot be stored.");
  }
  return `'${value.replace(/'/g, "''")}'`;
}

export function sqlStringList(values: readonly string[]): string {
  return values.length > 0 ? `(${values.map((value) => sqlString(value)).join(", ")})` : "('')";
}

export function sqlStringPairList(values: Array<[string, string]>): string {
  return values.length > 0
    ? `(${values.map(([left, right]) => `(${sqlString(left)}, ${sqlString(right)})`).join(", ")})`
    : "(('', ''))";
}

export function parseHexJson<T>(value: unknown, context: string): T {
  if (typeof value !== "string" || value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
    throw new Error(`Invalid hexadecimal JSON returned for ${context}.`);
  }
  let json: string;
  try {
    json = UTF8_DECODER.decode(Buffer.from(value, "hex"));
  } catch {
    throw new Error(`Invalid UTF-8 JSON returned for ${context}.`);
  }
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new Error(`Invalid JSON returned for ${context}.`);
  }
}

export function parseHexText(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
    throw new Error(`Invalid hexadecimal text returned for ${context}.`);
  }
  try {
    return UTF8_DECODER.decode(Buffer.from(value, "hex"));
  } catch {
    throw new Error(`Invalid UTF-8 text returned for ${context}.`);
  }
}

export function sqliteBoolean(value: number | string | boolean | null | undefined): boolean {
  return value === 1 || value === "1" || value === true || value === "true";
}

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** A subject's stylesheets (src/renderer/styles/views/<subject>/) as one text, for checks of what they say. */
export function styleSource(subject: string): string {
  const folder = resolve("src/renderer/styles/views", subject);
  return readdirSync(folder).filter((name) => name.endsWith(".css")).sort()
    .map((name) => readFileSync(resolve(folder, name), "utf8")).join("\n");
}

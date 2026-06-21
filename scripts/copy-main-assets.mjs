import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const source = path.join(repoRoot, "src/main/appSkills");
const target = path.join(repoRoot, "dist/main/main/appSkills");

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });

import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
for (const dir of ["appSkills", "prompts"]) {
  const source = path.join(repoRoot, "src/main", dir);
  const target = path.join(repoRoot, "dist/main/main", dir);
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
}

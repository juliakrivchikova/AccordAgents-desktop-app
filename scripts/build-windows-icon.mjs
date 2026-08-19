import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const sourcePath = path.join(repoRoot, "src", "renderer", "assets", "accordagents-mark.png");
const targetPath = path.join(repoRoot, "assets", "icon.ico");

const icon = await pngToIco(sourcePath, { interpolation: "bicubicInterpolation" });
await writeFile(targetPath, icon);
process.stdout.write(`Updated ${targetPath}\n`);

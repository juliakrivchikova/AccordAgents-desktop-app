#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const compiledContractPath = path.join(repoRoot, "dist/main/shared/appMcpToolContracts.js");
const generatedPath = path.join(repoRoot, "src/main/services/remoteAppMcpTools.generated.ts");

function generatedSource(contracts) {
  const serialized = JSON.stringify(contracts, null, 2);
  const snippet = [
    `const REMOTE_APP_MCP_TOOL_CONTRACTS = ${serialized};`,
    "const REMOTE_APP_MCP_TOOL_HANDLER_BY_NAME = Object.fromEntries(",
    "  REMOTE_APP_MCP_TOOL_CONTRACTS.map((contract) => [contract.definition.name, contract.handler])",
    ");"
  ].join("\n");
  return `// GENERATED FILE — do not edit. Source: src/shared/appMcpToolContracts.ts
// Regenerate after build: npm run build:main && node scripts/generate-app-mcp-worker-contract.mjs

export const REMOTE_APP_MCP_TOOL_CONTRACTS = ${serialized} as const;

export const REMOTE_APP_MCP_WORKER_CONTRACT_SNIPPET: string = ${JSON.stringify(snippet)};
`;
}

async function main() {
  const check = process.argv.includes("--check");
  let contractModule;
  try {
    contractModule = await import(`${pathToFileURL(compiledContractPath).href}?v=${Date.now()}`);
  } catch {
    throw new Error("Build the main process before generating the worker app-MCP contract: npm run build:main");
  }
  const contracts = contractModule.remoteAppMcpToolContracts();
  const next = generatedSource(contracts);
  const current = await readFile(generatedPath, "utf8").catch(() => "");
  if (check) {
    if (current !== next) {
      throw new Error("Stale worker app-MCP contract. Run npm run build:main && node scripts/generate-app-mcp-worker-contract.mjs, then commit the output.");
    }
    console.log("worker app-MCP contract is current.");
    return;
  }
  if (current === next) {
    console.log("worker app-MCP contract already current.");
    return;
  }
  await writeFile(generatedPath, next, "utf8");
  console.log(`wrote ${path.relative(repoRoot, generatedPath)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

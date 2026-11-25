import type { ChatAppToolCapability } from "../types";
import { hasChatAppToolCapability } from "../appTools";
import { ARTIFACT_DRAFT_TOOLS } from "./artifactDraftTools";
import { ARTIFACT_TOOLS } from "./artifactTools";
import { CHAT_TOOLS } from "./chatTools";
import { DELEGATION_TOOLS } from "./delegationTools";
import { MEMBER_REQUEST_TOOLS } from "./memberRequestTools";
import { MEMORY_TOOLS } from "./memoryTools";
import { PERMISSION_TOOLS } from "./permissionTools";
import { ROSTER_TOOLS } from "./rosterTools";
import { SCRIPT_TOOLS } from "./scriptTools";
import { APP_ARTIFACT_TOOL_NAMES } from "./toolNames";
import type { AppMcpToolContract, AppMcpToolDefinition, AppMcpToolPolicy, RemoteAppMcpToolHandler } from "./types";

export const APP_MCP_TOOL_CONTRACTS: readonly AppMcpToolContract[] = [
  ...PERMISSION_TOOLS,
  ...CHAT_TOOLS,
  ...ARTIFACT_TOOLS,
  ...ARTIFACT_DRAFT_TOOLS,
  ...MEMBER_REQUEST_TOOLS,
  ...ROSTER_TOOLS,
  ...SCRIPT_TOOLS,
  ...MEMORY_TOOLS,
  ...DELEGATION_TOOLS
];

export const APP_MCP_TOOL_POLICIES: readonly AppMcpToolPolicy[] = [...APP_MCP_TOOL_CONTRACTS]
  .sort((left, right) => left.policyOrder - right.policyOrder)
  .map(({ name, capability, effect }) => ({ name, capability, effect }));

export function appMcpToolPoliciesForCapabilities(
  capabilities: ChatAppToolCapability[]
): AppMcpToolPolicy[] {
  return APP_MCP_TOOL_POLICIES.filter(
    (policy) => !policy.capability || hasChatAppToolCapability(capabilities, policy.capability)
  );
}

export function appMcpToolNamesForCapabilities(capabilities: ChatAppToolCapability[]): string[] {
  return appMcpToolPoliciesForCapabilities(capabilities).map((policy) => policy.name);
}

export function autoPreauthorizedAppMcpToolNames(toolNames: string[]): string[] {
  const exposed = new Set(toolNames);
  return APP_MCP_TOOL_POLICIES
    .filter((policy) => policy.effect === "app-managed" && exposed.has(policy.name))
    .map((policy) => policy.name);
}

export function appMcpToolDefinitionsForCapabilities(
  capabilities: ChatAppToolCapability[]
): AppMcpToolDefinition[] {
  return APP_MCP_TOOL_CONTRACTS
    .filter((contract) => !contract.capability || hasChatAppToolCapability(capabilities, contract.capability))
    .map((contract) => ({ name: contract.name, ...contract.desktop }));
}

export function artifactToolDefinitions(): AppMcpToolDefinition[] {
  const artifactNames = new Set<string>(APP_ARTIFACT_TOOL_NAMES);
  return APP_MCP_TOOL_CONTRACTS
    .filter((contract) => artifactNames.has(contract.name))
    .map((contract) => ({ name: contract.name, ...contract.desktop }));
}

export function remoteAppMcpToolContracts(): Array<{
  handler: RemoteAppMcpToolHandler;
  definition: AppMcpToolDefinition;
}> {
  return APP_MCP_TOOL_CONTRACTS
    .filter((contract) => Boolean(contract.worker))
    .sort((left, right) => (left.worker?.order ?? 0) - (right.worker?.order ?? 0))
    .map((contract) => ({
      handler: contract.worker!.handler,
      definition: {
        name: contract.name,
        ...contract.worker!.definition,
        ...(contract.worker!.definition.annotations
          ? {}
          : contract.desktop.annotations ? { annotations: contract.desktop.annotations } : {})
      }
    }));
}

export const REMOTE_APP_MCP_TOOL_NAMES: readonly string[] = remoteAppMcpToolContracts()
  .map((contract) => contract.definition.name);

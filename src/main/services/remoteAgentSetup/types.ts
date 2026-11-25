import type { CommandOptions, CommandResult } from "../command";
import type { RemoteMirrorSyncRunner } from "../remoteMirrorSync";
import type { RemoteRunWorkerTarget } from "../remoteWorkerTarget";
import { PORTABLE_AGENT_SETUP_VERSION } from "./constants";

export interface PortableAgentSetupInvocation {
  fingerprint: string;
  codexConfigOverrides?: string[];
  claudeMcpServers?: Record<string, unknown>;
  advisories?: string[];
}

export interface RemoteAgentSetupSyncRequest {
  worker: RemoteRunWorkerTarget;
  sourceEnvironment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface RemoteAgentSetupSyncRunner {
  sync(request: RemoteAgentSetupSyncRequest): Promise<PortableAgentSetupInvocation>;
}

export interface PortableAgentSetupManifestLink {
  source: string;
  root: "codex" | "agents" | "claude" | "gemini";
  target: string;
}

export interface PortableAgentSetupManifest {
  version: typeof PORTABLE_AGENT_SETUP_VERSION;
  fingerprint: string;
  sourceFingerprint: string;
  fileCount: number;
  totalBytes: number;
  links: PortableAgentSetupManifestLink[];
}

export interface PortableAgentSetupBundle extends PortableAgentSetupInvocation {
  localPath: string;
  manifest: PortableAgentSetupManifest;
  cleanup(): Promise<void>;
}

export interface PortableAgentSetupBuildOptions {
  homeDir?: string;
  codexHomeDir?: string;
  claudeConfigDir?: string;
  geminiConfigDir?: string;
  tempDir?: string;
  signal?: AbortSignal;
  sourceFingerprint?: string;
  preparedInvocation?: PortableAgentSetupPreparedInvocation;
}

export interface PortableAgentSetupRoots {
  homeDir: string;
  codexHomeDir: string;
  claudeConfigDir: string;
  geminiConfigDir: string;
  agentsHomeDir: string;
}

export interface PortableCopyBudget {
  fileCount: number;
  totalBytes: number;
  signal?: AbortSignal;
}

export interface PortableAgentSetupPreparedInvocation {
  codexConfigOverrides?: string[];
  claudeMcpServers?: Record<string, unknown>;
  advisories?: string[];
}

export type PortableCommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions
) => Promise<CommandResult>;

export interface DefaultRemoteAgentSetupSyncOptions {
  homeDir?: string;
  codexHomeDir?: string;
  claudeConfigDir?: string;
  geminiConfigDir?: string;
  tempDir?: string;
  mirrorSync?: RemoteMirrorSyncRunner;
  commandRunner?: PortableCommandRunner;
  logger?: (event: string, payload: Record<string, unknown>) => void;
}

export interface PortableSetupRemoteState {
  fingerprint?: unknown;
  sourceFingerprint?: unknown;
}

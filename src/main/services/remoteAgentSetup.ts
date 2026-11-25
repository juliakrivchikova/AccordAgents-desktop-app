// The User's CLI setup (skills, MCP servers, config) as it goes to a machine.
export { PORTABLE_AGENT_SETUP_VERSION } from "./remoteAgentSetup/constants";
export type {
  PortableAgentSetupInvocation, RemoteAgentSetupSyncRequest, RemoteAgentSetupSyncRunner, PortableAgentSetupManifestLink,
  PortableAgentSetupManifest, PortableAgentSetupBundle
} from "./remoteAgentSetup/types";
export { DefaultRemoteAgentSetupSync } from "./remoteAgentSetup/setupSync";
export { buildPortableAgentSetupBundle, portableAgentSetupScaleAdvisories } from "./remoteAgentSetup/bundle";
export { sanitizeCodexPortableConfig, sanitizeClaudeMcpServers, codexPortableConfigOverrides } from "./remoteAgentSetup/portableConfig";
export { remotePortableSetupActivationScript } from "./remoteAgentSetup/activationScript";

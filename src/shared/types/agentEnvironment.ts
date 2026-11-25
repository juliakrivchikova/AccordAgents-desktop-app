export type AgentEnvironmentValueProtection = "os-encrypted" | "local-obfuscated";

/** Custom: added or changed by the User. Automatic: read from this computer
 *  and kept in step with it. */
export type AgentEnvironmentVariableSource = "custom" | "automatic";

export interface AgentEnvironmentVariable {
  key: string;
  source: AgentEnvironmentVariableSource;
  /** The first and last characters with the middle hidden; never the value. */
  preview: string;
  updatedAt: string;
  /** A custom variable switched off before the switch was removed; members
   *  do not get it until a new value is saved. */
  enabled: boolean;
  /** An automatic value that is a path on this computer: members here get it,
   *  cloud machines do not. */
  thisComputerOnly: boolean;
}

export interface AgentEnvironmentSnapshot {
  variables: AgentEnvironmentVariable[];
}

export interface SaveAgentEnvironmentVariableRequest {
  key: string;
  value: string;
}

export interface DeleteAgentEnvironmentVariableRequest {
  key: string;
}

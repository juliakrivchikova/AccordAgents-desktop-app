import type { ChatAppToolCapability } from "../types";

export type AppMcpToolEffect = "app-managed" | "repository-filesystem" | "permission-bridge";

export interface AppMcpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  annotations?: Readonly<Record<string, boolean>>;
}

export type RemoteAppMcpToolHandler =
  | "permissions-request"
  | "chat-get-context"
  | "chat-get-participants"
  | "chat-read-messages"
  | "chat-send-message"
  | "chat-list-attachments"
  | "chat-read-attachment";

export interface AppMcpToolContract {
  name: string;
  policyOrder: number;
  capability?: ChatAppToolCapability;
  effect: AppMcpToolEffect;
  desktop: Omit<AppMcpToolDefinition, "name">;
  worker?: {
    order: number;
    handler: RemoteAppMcpToolHandler;
    definition: Omit<AppMcpToolDefinition, "name">;
  };
}

export interface AppMcpToolPolicy {
  name: string;
  capability?: ChatAppToolCapability;
  effect: AppMcpToolEffect;
}

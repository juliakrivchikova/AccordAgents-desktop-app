import type { LiveSocketServer } from "./types";

export const WebSocketServer = (require("ws") as { WebSocketServer: new (options: { noServer: true; maxPayload: number }) => LiveSocketServer }).WebSocketServer;

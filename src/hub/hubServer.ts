import type { Server } from "node:http";
import type { HubServerOptions } from "./hubServer/types";
import { createHubServerModules, type HubServerModules } from "./hubServer/modules";

export type { HubServerOptions } from "./hubServer/types";
export { HUB_NOT_ON_ROSTER } from "./hubServer/constants";
export { HubRequestError } from "./hubServer/httpAnswers";
export { certStamp } from "./hubServer/httpsCertificate";

/**
 * The hub's HTTP surface. Every route but the health check and the VAPID key
 * is signed by a device on the roster. The live socket only says where the
 * server's feed stands (and that a machine's settings changed), and devices
 * read the rest over HTTP; rooms forward live messages between the User's
 * devices without keeping them.
 */
export class HubServer {
  private readonly modules: HubServerModules;

  constructor(options: HubServerOptions) {
    this.modules = createHubServerModules({ options, now: options.now ?? Date.now });
    options.ops?.onApplied(({ entry }) => this.modules.liveSockets.broadcastOps(entry.seq));
  }

  /** The roster changed (or may have): read it again on the next request. */
  invalidateRoster(): void {
    this.modules.deviceAuth.invalidateRoster();
  }

  /** Plain HTTP. In production it answers only the certificate challenge
   *  and the health check (`openOnly`); the rest needs TLS. Tests and local
   *  runs serve everything. */
  listenHttp(port: number, host?: string, options: { openOnly?: boolean } = {}): Promise<Server> {
    return this.modules.httpListeners.listenHttp(port, host, options);
  }

  /** HTTPS with the certificate on disk, re-read when it is renewed. */
  listenHttps(port: number, files: { cert: string; key: string }, host?: string): Promise<Server> {
    return this.modules.httpListeners.listenHttps(port, files, host);
  }

  /**
   * Stops listening and closes every connection now: a phone's long wait
   * for news, a keep-alive connection, a live socket. A request waiting on
   * one of them would otherwise keep the program running long after a stop
   * (the service manager then waits for its kill timeout).
   */
  close(): Promise<void> {
    return this.modules.httpListeners.close();
  }
}

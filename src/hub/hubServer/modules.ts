import type { HubServerDependencies } from "./dependencies";
import { BlobFragments } from "./blobFragments";
import { DeviceAuth } from "./deviceAuth";
import { DeviceRequests } from "./deviceRequests";
import { HttpListeners } from "./httpListeners";
import { LiveSockets } from "./liveSockets";
import { PhoneEnrollment } from "./phoneEnrollment";
import { RequestRouter } from "./requestRouter";
import { Rooms } from "./rooms";

/** The server's parts. Each names the ones it uses in its constructor. */
export interface HubServerModules {
  readonly httpListeners: HttpListeners;
  readonly requestRouter: RequestRouter;
  readonly deviceAuth: DeviceAuth;
  readonly liveSockets: LiveSockets;
  readonly rooms: Rooms;
  readonly deviceRequests: DeviceRequests;
  readonly blobFragments: BlobFragments;
  readonly phoneEnrollment: PhoneEnrollment;
}

/** Builds every part around one registry: parts call each other only once all of them exist. */
export function createHubServerModules(deps: HubServerDependencies): HubServerModules {
  const modules = {} as { -readonly [Key in keyof HubServerModules]: HubServerModules[Key] };
  modules.httpListeners = new HttpListeners(modules, deps);
  modules.requestRouter = new RequestRouter(modules, deps);
  modules.deviceAuth = new DeviceAuth(deps);
  modules.liveSockets = new LiveSockets(modules, deps);
  modules.rooms = new Rooms(modules);
  modules.deviceRequests = new DeviceRequests(modules, deps);
  modules.blobFragments = new BlobFragments(deps);
  modules.phoneEnrollment = new PhoneEnrollment(modules, deps);
  return modules;
}

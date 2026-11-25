import type { StorageDependencies } from "./dependencies";
import { Backups } from "./database/backups";
import { ChatActivity } from "./activity/chatActivity";
import { ChatSearchIndex } from "./search/chatSearchIndex";
import { ConversationLists } from "./conversations/conversationLists";
import { ConversationReads } from "./conversations/conversationReads";
import { ConversationSaves } from "./conversations/conversationSaves";
import { DeviceIdentity } from "./database/deviceIdentity";
import { RelatedStores } from "./database/relatedStores";
import { RunCancels } from "./conversations/runCancels";
import { Schema } from "./database/schema";
import { Sqlite } from "./database/sqlite";
import { StartupRepairs } from "./database/startupRepairs";

/** The storage's parts. Each names the ones it uses in its constructor. */
export interface StorageModules {
  readonly sqlite: Sqlite;
  readonly relatedStores: RelatedStores;
  readonly schema: Schema;
  readonly backups: Backups;
  readonly startupRepairs: StartupRepairs;
  readonly deviceIdentity: DeviceIdentity;
  readonly conversationReads: ConversationReads;
  readonly conversationLists: ConversationLists;
  readonly conversationSaves: ConversationSaves;
  readonly runCancels: RunCancels;
  readonly chatActivity: ChatActivity;
  readonly chatSearchIndex: ChatSearchIndex;
}

/** Builds every part around one registry: parts call each other only once all of them exist. */
export function createStorageModules(deps: StorageDependencies): StorageModules {
  const modules = {} as { -readonly [Key in keyof StorageModules]: StorageModules[Key] };
  modules.sqlite = new Sqlite(modules, deps);
  modules.relatedStores = new RelatedStores(modules);
  modules.schema = new Schema(modules, deps);
  modules.backups = new Backups(modules, deps);
  modules.startupRepairs = new StartupRepairs(modules);
  modules.deviceIdentity = new DeviceIdentity(modules);
  modules.conversationReads = new ConversationReads(modules);
  modules.conversationLists = new ConversationLists(modules);
  modules.conversationSaves = new ConversationSaves(modules);
  modules.runCancels = new RunCancels(modules);
  modules.chatActivity = new ChatActivity(modules);
  modules.chatSearchIndex = new ChatSearchIndex(modules);
  return modules;
}

import { DeviceEventBlobStorage } from "../../deviceEventBlobStorage";
import { HubStorage } from "../../hubStorage";
import { HubOpsStore } from "../../hubOpsStore";
import { HubClientOpsStore } from "../../hubOpsClient";
import { NativeCommandStore } from "../../nativeCommandStore";
import { MachinePowerStore } from "../../machinePowerStore";
import type { StorageModules } from "../modules";

/** Other stores kept in the same database file. */
export class RelatedStores {
  private hubStorage?: HubStorage;
  private hubOpsStore?: HubOpsStore;
  private hubClientOpsStore?: HubClientOpsStore;
  private deviceEventBlobStorage?: DeviceEventBlobStorage;

  constructor(private readonly storage: Pick<StorageModules, "schema" | "sqlite">) {}

  nativeCommands(): NativeCommandStore {
    return new NativeCommandStore({ init: () => this.storage.schema.init(), query: <T>(sql: string) => this.storage.sqlite.queryJson<T>(sql), execute: sql => this.storage.sqlite.runSql(sql) });
  }

  machinePower(): MachinePowerStore {
    return new MachinePowerStore({ init: () => this.storage.schema.init(), query: <T>(sql: string) => this.storage.sqlite.queryJson<T>(sql), execute: sql => this.storage.sqlite.runSql(sql) });
  }

  /** The hub's tables: on the hub, its roster, phone pairing, notices and
   *  push subscriptions; on a device that uses one, where it stands with it. */
  hub(): HubStorage {
    this.hubStorage ??= new HubStorage({
      init: () => this.storage.schema.init(),
      query: <T>(sql: string) => this.storage.sqlite.queryJson<T>(sql),
      execute: (sql: string) => this.storage.sqlite.runSql(sql)
    });
    return this.hubStorage;
  }

  /** This device's operations for the User's server, and its failed sends. */
  hubClientOps(): HubClientOpsStore {
    this.hubClientOpsStore ??= new HubClientOpsStore({
      init: () => this.storage.schema.init(),
      query: <T>(sql: string) => this.storage.sqlite.queryJson<T>(sql),
      execute: (sql: string) => this.storage.sqlite.runSql(sql)
    });
    return this.hubClientOpsStore;
  }

  /** The server's accepted operations and turns (the User's server only). */
  hubOps(): HubOpsStore {
    this.hubOpsStore ??= new HubOpsStore({
      init: () => this.storage.schema.init(),
      query: <T>(sql: string) => this.storage.sqlite.queryJson<T>(sql),
      execute: (sql: string) => this.storage.sqlite.runSql(sql)
    });
    return this.hubOpsStore;
  }

  /** The User's server's bodies (pictures, avatars); no other device keeps any. */
  deviceEventBlobs(): DeviceEventBlobStorage {
    this.deviceEventBlobStorage ??= new DeviceEventBlobStorage({
      init: () => this.storage.schema.init(),
      query: <T>(sql: string) => this.storage.sqlite.queryJson<T>(sql),
      execute: (sql: string) => this.storage.sqlite.runSql(sql)
    });
    return this.deviceEventBlobStorage;
  }
}

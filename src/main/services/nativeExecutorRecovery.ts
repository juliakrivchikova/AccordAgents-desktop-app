import type { NativeSessionExecutor } from "../../shared/nativeCommands";
import { nativeHostIdentity, verifiedNativeHostReboot } from "./nativeHostIdentity";
import { NativeProcessRegistry } from "./nativeProcessRegistry";
import { readPosixProcessTableAsync } from "./processTermination";

/** A dead app is insufficient: its guardian must have closed the provider
 * tree, or the same OS host must have rebooted. No timeout grants ownership. */
export async function verifyNativeExecutorGone(executor: NativeSessionExecutor, registryPath: string): Promise<boolean> {
  const processes = await readPosixProcessTableAsync();
  if (!processes) return false;
  const app = processes.get(executor.pid);
  if (app?.startedAt === executor.startedAt && !app.state?.includes("Z")) return false;
  const registry = new NativeProcessRegistry(registryPath);
  await registry.init();
  const lease = await registry.get(`${executor.conversationId}:${executor.participantId}`);
  // No provider was admitted, or its supervisor has already verified closure.
  if (!lease || lease.phase === "closed") return true;
  if (verifiedNativeHostReboot(lease.host, await nativeHostIdentity())) {
    await registry.update({ ...lease, phase: "closed", shutdownReason: "host-rebooted" });
    return true;
  }
  return false;
}

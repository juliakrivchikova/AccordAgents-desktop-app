import type { DeviceEventBlobReference } from "../../shared/deviceEventBlobs";
import type { HubServerDependencies } from "./dependencies";

/** Pictures and other bytes, in fragments. */
export class BlobFragments {
  constructor(private readonly deps: Pick<HubServerDependencies, "options">) {}

  private async blobComplete(reference: DeviceEventBlobReference): Promise<boolean> {
    try {
      return await this.deps.options.storage.deviceEventBlobs().verify(reference);
    } catch {
      return false;
    }
  }

  /**
   * One fragment of a picture or an avatar, put up before the message (or
   * the catalog) that names it. A body that is complete is never touched
   * again, and while it is incomplete a fragment that differs replaces the
   * stored one: a wrong upload can delay a body, not spoil it.
   */
  async putBlobFragment(reference: DeviceEventBlobReference, index: number, bytes: Buffer): Promise<void> {
    if (await this.blobComplete(reference)) return;
    const blobs = this.deps.options.storage.deviceEventBlobs();
    const existing = await blobs.fragment(reference, index).catch(() => null);
    if (existing === null || (existing && existing.bytesBase64 !== bytes.toString("base64"))) {
      await blobs.replaceFragment(reference, index);
    }
    await blobs.store({ reference, index, bytesBase64: bytes.toString("base64") });
  }

  async blobFragment(reference: DeviceEventBlobReference, index: number): Promise<Buffer | undefined> {
    const fragment = await this.deps.options.storage.deviceEventBlobs().fragment(reference, index).catch(() => undefined);
    return fragment ? Buffer.from(fragment.bytesBase64, "base64") : undefined;
  }
}

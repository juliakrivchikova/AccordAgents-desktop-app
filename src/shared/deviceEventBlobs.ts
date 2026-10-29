/** A body kept on the User's server by its content (a picture a phone sent,
 *  an avatar the composer's catalog names): messages and the catalog name it
 *  by this reference. The type tag is the stored form and does not change. */
export interface DeviceEventBlobReference {
  type: "device.event.blob";
  blobHash: string;
  byteLength: number;
  fragments: number;
}

export interface DeviceEventBlobFragment {
  reference: DeviceEventBlobReference;
  index: number;
  bytesBase64: string;
}

/** A body travels and is stored in fragments of at most this many bytes. */
export const BLOB_FRAGMENT_MAX_BYTES = 384 * 1024;

export function isDeviceEventBlobReference(value: unknown): value is DeviceEventBlobReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Partial<DeviceEventBlobReference>;
  return ref.type === "device.event.blob" && typeof ref.blobHash === "string" && /^sha256:[a-f0-9]{64}$/.test(ref.blobHash) &&
    Number.isSafeInteger(ref.byteLength) && ref.byteLength! > 0 && Number.isSafeInteger(ref.fragments) &&
    ref.fragments === Math.ceil(ref.byteLength! / BLOB_FRAGMENT_MAX_BYTES);
}

export function fragmentByteLength(reference: DeviceEventBlobReference, index: number): number {
  if (!isDeviceEventBlobReference(reference) || !Number.isSafeInteger(index) || index < 0 || index >= reference.fragments) {
    throw new Error("Invalid blob fragment identity.");
  }
  return index === reference.fragments - 1
    ? reference.byteLength - index * BLOB_FRAGMENT_MAX_BYTES
    : BLOB_FRAGMENT_MAX_BYTES;
}

import { BLOB_FRAGMENT_MAX_BYTES } from "./machineEvents";

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

export const DEVICE_EVENT_INLINE_BYTES = 32 * 1024;

export function isDeviceEventBlobReference(value: unknown): value is DeviceEventBlobReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Partial<DeviceEventBlobReference>;
  return ref.type === "device.event.blob" && typeof ref.blobHash === "string" && /^sha256:[a-f0-9]{64}$/.test(ref.blobHash) &&
    Number.isSafeInteger(ref.byteLength) && ref.byteLength! > 0 && Number.isSafeInteger(ref.fragments) &&
    ref.fragments === Math.ceil(ref.byteLength! / BLOB_FRAGMENT_MAX_BYTES);
}

export function fragmentByteLength(reference: DeviceEventBlobReference, index: number): number {
  if (!isDeviceEventBlobReference(reference) || !Number.isSafeInteger(index) || index < 0 || index >= reference.fragments) {
    throw new Error("Invalid device event blob fragment identity.");
  }
  return index === reference.fragments - 1
    ? reference.byteLength - index * BLOB_FRAGMENT_MAX_BYTES
    : BLOB_FRAGMENT_MAX_BYTES;
}

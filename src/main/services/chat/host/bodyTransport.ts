import type { DeviceEventBlobReference } from "../../../../shared/deviceEventBlobs";

/** What a device's live link to its machines (the desktop) or to its desktop
 *  (a machine) gives a chat. Turns, Stops and compactions never travel here:
 *  they are the User's server's (agreements Д1, Д4). */
export interface MachineLinkPort {
  /** The bytes of a picture this copy does not hold on disk. Only a machine
   *  supplies this: replication brings an attachment's metadata here without
   *  its file, and the desktop that owns the chat still has it. */
  fetchAttachment?(conversationId: string, attachmentId: string): Promise<{ dataBase64: string }>;
}

/** How pictures and session bodies reach this device: the machines' link and the User's server. */
export class BodyTransport {
  /** Reads a picture the phone sent from the User's server. */
  hubBlobReader?: (reference: DeviceEventBlobReference) => Promise<Buffer>;
  /** Puts a body on the User's server (a member's session for its move). */
  hubBlobWriter?: (bytes: Buffer) => Promise<DeviceEventBlobReference>;
  machineLink?: MachineLinkPort;

  setMachineLink(link: MachineLinkPort | undefined): void {
    this.machineLink = link;
  }

  /** Reads a body from the User's server by its reference (a picture sent
   *  from the phone). */
  setHubBlobReader(reader: ((reference: DeviceEventBlobReference) => Promise<Buffer>) | undefined): void {
    this.hubBlobReader = reader;
  }

  /** Puts a body on the User's server and returns its reference. */
  setHubBlobWriter(writer: ((bytes: Buffer) => Promise<DeviceEventBlobReference>) | undefined): void {
    this.hubBlobWriter = writer;
  }
}

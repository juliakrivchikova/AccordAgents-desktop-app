import type { HubDevice } from "../../shared/hubProtocol";
import { TURN_FINISHED_NOTE_SOURCE, turnFinishedNoteOf } from "../../shared/turnFinishedNoteSource";
import { ACCORD_CLOSED_SOURCE, accordClosedLaunchId } from "../../shared/accordProgress";
import type { ChatMessage, Conversation } from "../../shared/types";
import { homeDeviceId } from "./chatRecords";
import type { Rejection } from "./types";

/** Who may add a message: anyone, except a member's message, which only
 *  the device that member runs on writes (Д4). */
export function mayWriteMessage(device: HubDevice, conversation: Conversation, message: ChatMessage, devices: HubDevice[]): Rejection | undefined {
  // The User's words from a machine are only the hidden ones the app
  // writes for its own member (her answer to its choice, an approval's
  // control word): never one the chat shows, or a member reads, as hers.
  if (device.role === "machine" && message.role === "user" && message.metadata?.hiddenFromTimeline !== true) {
    return { rejected: "A cloud machine writes the User's words only as a hidden answer for its own member." };
  }
  // A note that a member finished answering speaks for that member, so it
  // comes from the device the member runs on, as the member's reply does.
  if (message.role === "system" && message.metadata?.appMessageSource === TURN_FINISHED_NOTE_SOURCE) {
    const note = turnFinishedNoteOf(message);
    if (!note) return { rejected: "A turn-finished note names its member and the reply it leads to." };
    if (homeDeviceId(conversation, note.participantId, devices) !== device.deviceId) {
      return { rejected: "Only the device this member runs on writes that it finished answering." };
    }
    return undefined;
  }
  // A closed Accord's line is the User's own view of the chat: written by
  // her computer or her phone, once per Accord, for an Accord of this chat.
  if (message.role === "system" && message.metadata?.appMessageSource === ACCORD_CLOSED_SOURCE) {
    const launchId = accordClosedLaunchId(message);
    if (device.role === "machine") return { rejected: "Only the User's computer or phone folds an Accord into the chat." };
    if (!launchId || launchId.length > 200 || message.content.length > 240) return { rejected: "A closed Accord's line names its Accord." };
    const known = conversation.messages.some((item) => item.id === launchId ||
      (item.role === "system" && item.metadata?.accordLaunchMessageId === launchId));
    if (!known) return { rejected: "This chat has no such Accord." };
    if (conversation.messages.some((item) => accordClosedLaunchId(item) === launchId)) return { rejected: "This Accord is already folded into the chat." };
    return undefined;
  }
  if (message.role !== "participant") return undefined;
  if (!message.participantId) return { rejected: "A member's message names its member." };
  const home = homeDeviceId(conversation, message.participantId, devices);
  if (!home) return { rejected: "This member is not in the chat, or its machine is not on the server's roster." };
  if (home !== device.deviceId) return { rejected: "Only the device this member runs on writes its messages." };
  return undefined;
}

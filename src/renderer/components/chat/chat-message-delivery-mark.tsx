import { MESSAGE_MARK_SENT, MESSAGE_MARK_TAKEN, messageDeliveryMark } from "../../../shared/messageDelivery";
import type { ChatMessage, ChatParticipant } from "../../../shared/types";

/** Where the User's message stands on her server (agreements Д3, Д5), in the
 *  phone app's words; nothing for any other message. */
export function ChatMessageDeliveryMark(props: { message: ChatMessage; participants?: ChatParticipant[] }) {
  const mark = messageDeliveryMark(props.message, (participantId) => props.participants?.find((item) => item.id === participantId)?.handle);
  if (!mark) return null;
  const settled = mark === MESSAGE_MARK_SENT || mark.startsWith(MESSAGE_MARK_TAKEN);
  return <span className={`message-delivery${settled ? "" : " is-waiting"}`}>{mark}</span>;
}

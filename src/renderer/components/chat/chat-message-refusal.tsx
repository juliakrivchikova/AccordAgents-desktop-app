import type { MessageDelivery } from "../../../shared/messageDelivery";

/** Under a message of the User's the server refused: why (the User, 2026-10-29). */
export function ChatMessageRefusal(props: { delivery: MessageDelivery | undefined }) {
  if (props.delivery?.state !== "refused") return null;
  return <div className="message-refused">{props.delivery.text}</div>;
}

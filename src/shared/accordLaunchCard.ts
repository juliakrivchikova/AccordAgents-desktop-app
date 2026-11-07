// The card the timeline shows for the message that starts an Accord. The
// message itself stays the launch prompt ChatService.startAccord writes
// ("@taylor /accord", the subject, the selected members, the instruction),
// because that text is exactly what the facilitator receives as its turn;
// only the screen turns it into a card, on the desktop and on the phone alike.
// Launches already in the User's chats have the same text ("participants"
// until 2026-07-22, "members" since), so they become cards too.

export interface AccordLaunchCard {
  /** The facilitator's handle without "@". */
  facilitator: string;
  /** The selected members' handles without "@", in the order the User chose them. */
  members: string[];
  /** What the User asked the Accord about, as she wrote it. */
  subject: string;
}

const FIRST_LINE = /^@(\S+) \/accord$/;
const MEMBERS_LINE = /^Selected accord (?:members|participants): (.+)\.$/;
// The instruction's last sentence has said what the app enabled in three
// ways over time; the rest of it never changed.
const INSTRUCTION = /^Run the accord skill for exactly those selected (?:members|participants) and this subject\. Use app_chat_request_participants for those (?:members|participants) only\. The app has [^\n]+\.$/;

/** The card for an Accord launch prompt, or undefined when the text is not one. */
export function parseAccordLaunchCard(content: unknown): AccordLaunchCard | undefined {
  if (typeof content !== "string") {
    return undefined;
  }
  const lines = content.replace(/\r\n?/g, "\n").trim().split("\n");
  // Header (3 lines), at least one subject line, blank, members, instruction.
  if (lines.length < 7) {
    return undefined;
  }
  const facilitator = FIRST_LINE.exec(lines[0]!)?.[1];
  if (!facilitator || lines[1] !== "" || lines[2] !== "Subject:") {
    return undefined;
  }
  const instruction = lines[lines.length - 1]!;
  const membersLine = MEMBERS_LINE.exec(lines[lines.length - 2]!);
  if (!INSTRUCTION.test(instruction) || !membersLine || lines[lines.length - 3] !== "") {
    return undefined;
  }
  const members = membersLine[1]!.split(", ").map((handle) => handle.trim()).filter(Boolean);
  if (members.length === 0 || members.some((handle) => /\s/.test(handle))) {
    return undefined;
  }
  const subject = lines.slice(3, lines.length - 3).join("\n").trim();
  if (!subject) {
    return undefined;
  }
  return { facilitator, members, subject };
}

/** The subject's first line, the card's title; the rest is its body. */
export function accordLaunchTitleAndBody(subject: string): { title: string; body?: string } {
  const [first = "", ...rest] = subject.split("\n");
  const body = rest.join("\n").trim();
  return body ? { title: first.trim(), body } : { title: first.trim() };
}

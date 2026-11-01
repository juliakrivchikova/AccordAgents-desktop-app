import assert from "node:assert/strict";
import { act, type ReactTestRenderer } from "react-test-renderer";

import type { ChatAgentActivityEvent, ChatAgentActivityKind } from "../../../shared/types";
import {
  ChatExpandedProcessingTranscript,
  ChatInlineTranscript,
  StreamingMessageContent
} from "./chat-streaming";
import { useChatActivityDisclosure } from "./use-chat-activity-disclosure";

export const NOW = "2026-07-12T12:00:00.000Z";

export type ActivityHarnessMode =
  | "stream-empty"
  | "stream-tail"
  | "stream-break"
  | "stream-completed"
  | "finished"
  | "unmounted"
  | "timeline-only"
  | "timeline-and-thread";

export function ActivityDisclosureHarness(props: {
  activityEvents: ChatAgentActivityEvent[];
  conversationId?: string;
  mode?: ActivityHarnessMode;
  /** Streamed content for the stream modes; overrides the mode's preset text. */
  content?: string;
  /** A cloud run's own status for the stream modes. */
  statusLabel?: string;
}): JSX.Element | null {
  const activityDisclosure = useChatActivityDisclosure(props.conversationId ?? "conversation-1");
  const mode = props.mode ?? "stream-empty";
  if (mode === "unmounted") {
    return null;
  }
  if (mode === "finished") {
    const transcriptOpen = activityDisclosure.expandedProcessingTranscriptMessageIds.has("message-1");
    return (
      <>
        <button type="button" aria-expanded={transcriptOpen} onClick={() => activityDisclosure.toggleProcessingTranscript("message-1")}>
          {transcriptOpen ? "Hide full stream" : "Show full stream"}
        </button>
        {transcriptOpen && (
          <ChatExpandedProcessingTranscript activityDisclosure={activityDisclosure} activityEvents={props.activityEvents} view={{
            leadingSegments: [{ key: "full", content: "Finished", startOffset: 0, endOffset: 8 }], renderFinalContent: false, notices: []
          }} />
        )}
      </>
    );
  }
  if (mode === "timeline-only" || mode === "timeline-and-thread") {
    return (
      <>
        <ChatInlineTranscript activityDisclosure={activityDisclosure} content="" activityEvents={props.activityEvents} />
        {mode === "timeline-and-thread" && (
          <ChatInlineTranscript activityDisclosure={activityDisclosure} content="" activityEvents={props.activityEvents} />
        )}
      </>
    );
  }
  const content = props.content ?? (mode === "stream-tail"
    ? "First paragraph."
    : mode === "stream-break"
      ? "First paragraph.\n\n"
      : mode === "stream-completed"
        ? "First paragraph.\n\nSecond paragraph."
        : undefined);
  return (
    <StreamingMessageContent
      activityDisclosure={activityDisclosure}
      statusLabel={props.statusLabel}
      content={content}
      activityEvents={props.activityEvents}
    />
  );
}

export function activityEvent(
  kind: ChatAgentActivityKind,
  sequence: number,
  label = `Activity ${kind}`,
  detail?: string
): ChatAgentActivityEvent {
  return {
    id: `activity-${kind}-${sequence}`,
    sequence,
    kind,
    label,
    detail,
    createdAt: NOW,
    afterContentLength: 0
  };
}

export function buttonWithLabel(renderer: ReactTestRenderer, label: string): ReactTestRenderer["root"] {
  const button = renderer.root.findAllByType("button").find((item) => textContent(item).includes(label));
  assert.ok(button, `expected ${label} button`);
  return button;
}

export function activityRowLabels(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => typeof node.type === "string" && /(^| )chat-inline-activity-event( |$)/.test(String(node.props.className ?? "")))
    .map((row) => {
      const heading = row.find((node) => typeof node.type === "string" && /chat-inline-activity-heading/.test(String(node.props.className ?? "")));
      return textContent(heading) + (/is-live/.test(String(row.props.className)) && shimmers(row) ? "~live" : "");
    });
}

export function groupLines(renderer: ReactTestRenderer): string[] {
  return groupButtons(renderer).map((button) => textContent(button) + (shimmers(button) ? "~live" : ""));
}

export function groupButtons(renderer: ReactTestRenderer): ReactTestRenderer["root"][] {
  return renderer.root
    .findAll((node) => typeof node.type === "string" && /(^| )chat-inline-activity-group( |$)/.test(String(node.props.className ?? "")))
    .map((group) => group.findAllByType("button")[0]);
}

export function shimmers(node: ReactTestRenderer["root"]): boolean {
  return node.findAll((child) => /streaming-status-label/.test(String(child.props.className ?? ""))).length > 0;
}

export async function openGroups(renderer: ReactTestRenderer): Promise<void> {
  for (;;) {
    const collapsed = groupButtons(renderer).find((button) => button.props["aria-expanded"] === false);
    if (!collapsed) {
      return;
    }
    await act(async () => collapsed.props.onClick());
  }
}

export function activityContent(renderer: ReactTestRenderer): ReactTestRenderer["root"] {
  return renderer.root.findByProps({ className: "chat-inline-activity-content" });
}

export function svgClassNames(node: ReactTestRenderer["root"]): string[] {
  return node.findAllByType("svg").map((svg) => String(svg.props.className ?? ""));
}

export function textContent(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (!node || typeof node !== "object") {
    return "";
  }
  const record = node as { children?: unknown[] };
  return Array.isArray(record.children) ? record.children.map(textContent).join("") : "";
}

import { createContext, memo, useContext, useMemo, type ReactNode } from "react";
import { FileBox } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  parseInlineCodeFileLinkTarget,
  parseMarkdownInline,
  type MarkdownInlineNode
} from "../../../shared/markdownInline";
import { markdownBlocks, type MarkdownBlock } from "./markdown-blocks";
import { FileLink } from "./local-file-link";
import { MentionDirectoryContext, ParticipantHoverCard, profileHandleLabel, useHoverCard } from "./participant-hover-card";
import { ArtifactsContext } from "../artifacts/artifacts-context";
import { artifactSummaryStatusLabel } from "../../../shared/artifacts";
import { sessionsMentionPieces } from "../../../shared/mainSessionView";
import { useChatSessionsLinks, type ChatSessionsLinks } from "../chat/chat-sessions-links";
import { ProviderIcon } from "../chat/provider-icon";

// A clickable reference to another chat message. Authors write `[label](#msg:<id>)` (or a bare
// `#msg:<id>`); we render a link that scrolls the referenced message into view and flashes it.
// This keeps the user-facing text clean instead of leaking raw message ids.

export type MessageFocusHandler = (messageId: string) => boolean | void;

export const MessageLinkContext = createContext<MessageFocusHandler | undefined>(undefined);

// In the sessions view (docs/main-session.md) a member is a chip with its
// provider's logo and its task's title that opens its session. Which `@handle`
// is a member's chip, in prose and in code, is one rule with the phone's
// (sessionsMentionPieces); everything else stays as written.
function SessionsMention({ handle, links }: { handle: string; links: ChatSessionsLinks }): JSX.Element {
  const member = links.byHandle.get(handle.toLowerCase());
  if (!member) {
    return <>{`@${handle}`}</>;
  }
  return (
    <button
      type="button"
      className="chat-member-chip"
      data-testid="chat-member-chip"
      data-participant-id={member.id}
      onClick={(event) => {
        event.preventDefault();
        links.openMember(member.id, member.focusMessageId);
      }}
    >
      {member.kind && <ProviderIcon className="chat-provider-icon is-chip" kind={member.kind} label={member.title} bare />}
      <span>{member.title}</span>
    </button>
  );
}

/** Inline code. In the sessions view a member's handle in it is the
 *  member's chip, between the code around it; the rest of the code stays as
 *  written. */
function InlineCode({ text }: { text: string }): JSX.Element {
  const links = useChatSessionsLinks();
  const pieces = links ? sessionsMentionPieces(text, (handle) => links.byHandle.has(handle), (handle) => handle === links.mainHandle?.toLowerCase()) : [];
  if (!links || !pieces.some((piece) => piece.handle !== undefined)) {
    return <code>{text}</code>;
  }
  return (
    <>
      {pieces.map((piece, index) => piece.handle !== undefined
        ? <SessionsMention key={index} handle={piece.handle} links={links} />
        : piece.text.trim() ? <code key={index}>{piece.text}</code> : piece.text)}
    </>
  );
}

function Mention({ handle }: { handle: string }): JSX.Element {
  const links = useChatSessionsLinks();
  return links ? <SessionsMention handle={handle} links={links} /> : <DirectoryMention handle={handle} />;
}

/** The sessions view's reading of a run of text and mentions: the parser's
 *  mentions are written back as text and read again by the shared rule, so
 *  only a member's exact `@handle` stays a mention (its chip). */
function withSessionsMentions(nodes: MarkdownInlineNode[], links: ChatSessionsLinks): MarkdownInlineNode[] {
  const result: MarkdownInlineNode[] = [];
  let run = "";
  const flush = (): void => {
    if (!run) return;
    for (const piece of sessionsMentionPieces(run, (handle) => links.byHandle.has(handle), (handle) => handle === links.mainHandle?.toLowerCase())) {
      result.push(piece.handle !== undefined ? { type: "mention", handle: piece.handle } : { type: "text", text: piece.text });
    }
    run = "";
  };
  for (const node of nodes) {
    if (node.type === "text") {
      run += node.text;
    } else if (node.type === "mention") {
      run += `@${node.handle}`;
    } else {
      flush();
      result.push(node.type === "strong" ? { ...node, children: withSessionsMentions(node.children, links) } : node);
    }
  }
  flush();
  return result;
}

function DirectoryMention({ handle }: { handle: string }): JSX.Element {
  const directory = useContext(MentionDirectoryContext);
  const profile = directory?.get(handle.toLowerCase());
  const { open, setOpen, openCard, scheduleClose } = useHoverCard();

  if (!profile) {
    return <span className="chat-mention">{`@${handle}`}</span>;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <span
          className="chat-mention"
          tabIndex={0}
          role="button"
          aria-label={`${profileHandleLabel(profile.handle)} details`}
          onMouseEnter={openCard}
          onMouseLeave={scheduleClose}
          onFocus={openCard}
          onBlur={scheduleClose}
        >
          {profileHandleLabel(profile.handle)}
        </span>
      </PopoverTrigger>
      <PopoverContent
        className="chat-mention-card"
        side="top"
        align="start"
        sideOffset={6}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onMouseEnter={openCard}
        onMouseLeave={scheduleClose}
        onFocus={openCard}
        onBlur={scheduleClose}
      >
        <ParticipantHoverCard profile={profile} />
      </PopoverContent>
    </Popover>
  );
}

export function focusRenderedMessage(
  root: ParentNode | null | undefined,
  messageId: string,
  options: { scroll?: boolean } = {}
): boolean {
  if (!root || typeof window === "undefined") {
    return false;
  }
  const el = Array.from(root.querySelectorAll<HTMLElement>("[data-message-id]"))
    .find((candidate) => candidate.dataset.messageId === messageId);
  if (!el) {
    return false;
  }
  if (options.scroll !== false) {
    el.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
  }
  root.querySelectorAll<HTMLElement>(".message-focused")
    .forEach((candidate) => candidate.classList.remove("message-focused"));
  el.classList.add("message-focused");
  el.classList.add("message-flash");
  window.setTimeout(() => el.classList.remove("message-flash"), 1500);
  return true;
}

/** How anything in the chat goes to a message: the chat scrolls to it and
 *  marks it, loading older messages when it is far above; without a chat
 *  view, the message on screen is scrolled to. */
export function useFocusChatMessage(): (messageId: string) => void {
  const focusMessage = useContext(MessageLinkContext);
  return (messageId) => {
    if (focusMessage?.(messageId) === true) {
      return;
    }
    if (typeof document !== "undefined") {
      focusRenderedMessage(document, messageId);
    }
  };
}

function MessageLink({ messageId, label }: { messageId: string; label: string }): JSX.Element {
  const focusMessage = useFocusChatMessage();
  const activate = (): void => focusMessage(messageId);

  return (
    <a
      className="message-link"
      role="button"
      tabIndex={0}
      onClick={(event) => { event.preventDefault(); activate(); }}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); } }}
    >
      {label}
    </a>
  );
}

// A reference to a chat artifact: `[label](#artifact:<id>)` or bare `#artifact:<id>`.
// The link always shows the artifact's CURRENT name (falling back to the authored
// label if the artifact is unknown), while approval stays in the hover text. It
// never embeds the artifact body. Activating it opens the artifact in the panel.
function ArtifactLink({ artifactId, label }: { artifactId: string; label?: string }): JSX.Element {
  const artifacts = useContext(ArtifactsContext);
  const summary = artifacts?.byId.get(artifactId);
  const name = summary?.name ?? label ?? "artifact";
  const title = summary
    ? `Open artifact "${summary.name}" · ${artifactSummaryStatusLabel(summary)}`
    : "Artifact reference";
  const activate = (): void => {
    artifacts?.openArtifact(artifactId);
  };
  return (
    <a
      className={`artifact-link chat-draft-artifact-token${summary ? "" : " artifact-link-unknown"}`}
      role="button"
      tabIndex={0}
      title={title}
      onClick={(event) => { event.preventDefault(); activate(); }}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); } }}
    >
      <FileBox size={15} strokeWidth={2.2} aria-hidden /><span className="artifact-link-name">{name}</span>
    </a>
  );
}

function openExternalLink(url: string): void {
  void window.consensus.openExternal(url).catch((error) => {
    console.error("Failed to open external link.", error);
  });
}

function ExternalLink({ url, label }: { url: string; label: string }): JSX.Element {
  return (
    <a
      className="message-link external-link"
      href={url}
      onClick={(event) => {
        event.preventDefault();
        openExternalLink(url);
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) {
          return;
        }
        event.preventDefault();
        openExternalLink(url);
      }}
      onKeyDown={(event) => {
        if (event.key === " ") {
          event.preventDefault();
          openExternalLink(url);
        }
      }}
    >
      {label}
    </a>
  );
}

function MarkdownTextView({ content, recognizedCommand }: { content: string; recognizedCommand?: "goal" }): JSX.Element {
  const blocks = useMemo(() => markdownBlocks(content), [content]);
  const sessionsLinks = useChatSessionsLinks();
  if (blocks.length === 0) {
    return <div className="markdown-text" />;
  }
  const inline: InlineOptions = { recognizedCommand, sessionsLinks };
  return <div className="markdown-text">{blocks.map((block, index) => renderMarkdownBlock(block, index, inline))}</div>;
}

/** How a message's inline text is read: `/goal` as the command it starts,
 *  and in the sessions view members' handles by the shared rule. */
type InlineOptions = { recognizedCommand?: "goal"; sessionsLinks?: ChatSessionsLinks };

export const MarkdownText = memo(MarkdownTextView);
MarkdownText.displayName = "MarkdownText";

function renderMarkdownBlock(block: MarkdownBlock, index: number, inline: InlineOptions): ReactNode {
  if (block.type === "heading") {
    return (
      // Every level renders as h4 so the element never competes with the surrounding
      // page structure; aria-level carries the real depth so heading navigation is not flat.
      <h4 key={index} className={`markdown-heading markdown-heading-${block.level}`} aria-level={block.level + 3}>
        {renderInlineWithBreaks(block.text, `h-${index}`, inline)}
      </h4>
    );
  }
  if (block.type === "code") {
    return (
      <pre className="markdown-code" key={index}>
        <code>{block.content}</code>
      </pre>
    );
  }
  if (block.type === "ol") {
    return (
      <ol className="markdown-list" key={index} start={block.start}>
        {block.items.map((item, itemIndex) => (
          <li key={itemIndex}>{renderInlineWithBreaks(item, `li-${index}-${itemIndex}`, inline)}</li>
        ))}
      </ol>
    );
  }
  if (block.type === "ul") {
    return (
      <ul className="markdown-list" key={index}>
        {block.items.map((item, itemIndex) => (
          <li key={itemIndex}>{renderInlineWithBreaks(item, `li-${index}-${itemIndex}`, inline)}</li>
        ))}
      </ul>
    );
  }
  if (block.type === "table") {
    return (
      <div className="markdown-table-wrap" key={index}>
        <table className="markdown-table">
          <thead>
            <tr>
              {block.headers.map((header, headerIndex) => (
                <th key={headerIndex} scope="col">
                  {renderInlineWithBreaks(header, `t-${index}-h-${headerIndex}`, inline)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {block.headers.map((_, cellIndex) => (
                  <td key={cellIndex}>{renderInlineWithBreaks(row[cellIndex] ?? "", `t-${index}-${rowIndex}-${cellIndex}`, inline)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (block.type === "paragraph") {
    return <p key={index}>{renderInlineWithBreaks(block.lines.join("\n"), `p-${index}`, inline)}</p>;
  }
  return null;
}

function renderInlineWithBreaks(text: string, keyPrefix: string, inline: InlineOptions): ReactNode[] {
  return text.split("\n").flatMap((line, index, lines) => {
    const nodes = renderInline(line, `${keyPrefix}-${index}`, inline);
    return index < lines.length - 1 ? [...nodes, <br key={`${keyPrefix}-br-${index}`} />] : nodes;
  });
}

function renderInline(text: string, keyPrefix: string, inline: InlineOptions): ReactNode[] {
  const nodes = parseMarkdownInline(text, { recognizedCommand: inline.recognizedCommand });
  return (inline.sessionsLinks ? withSessionsMentions(nodes, inline.sessionsLinks) : nodes)
    .map((node, index) => renderInlineNode(node, `${keyPrefix}-${index}`));
}

function renderInlineNode(node: MarkdownInlineNode, key: string): ReactNode {
  if (node.type === "text") {
    return node.text;
  }
  if (node.type === "strong") {
    return <strong key={key}>{node.children.map((child, index) => renderInlineNode(child, `${key}-${index}`))}</strong>;
  }
  if (node.type === "code") {
    const fileTarget = parseInlineCodeFileLinkTarget(node.text);
    if (fileTarget) {
      return (
        <FileLink
          key={key}
          path={fileTarget.path}
          label={node.text}
          line={fileTarget.line}
          column={fileTarget.column}
          variant="inline-code"
        />
      );
    }
    return <InlineCode key={key} text={node.text} />;
  }
  if (node.type === "command") {
    return <span key={key} className="chat-command-token">/{node.command}</span>;
  }
  if (node.type === "mention") {
    return <Mention key={key} handle={node.handle} />;
  }
  if (node.type === "messageLink") {
    return <MessageLink key={key} messageId={node.messageId} label={node.label ?? "↳ message"} />;
  }
  if (node.type === "artifactLink") {
    return <ArtifactLink key={key} artifactId={node.artifactId} label={node.label} />;
  }
  if (node.type === "fileLink") {
    return <FileLink key={key} path={node.path} label={node.label} line={node.line} column={node.column} />;
  }
  if (node.type === "externalLink") {
    return <ExternalLink key={key} url={node.url} label={node.label} />;
  }
  return null;
}

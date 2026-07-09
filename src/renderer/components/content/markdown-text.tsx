import { createContext, useContext, type ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  parseInlineCodeFileLinkTarget,
  parseMarkdownInline,
  type MarkdownInlineNode
} from "../../../shared/markdownInline";
import { markdownBlocks, type MarkdownBlock } from "./markdown-blocks";
import { FileLink } from "./local-file-link";
import { MentionDirectoryContext, ParticipantHoverCard, profileHandleLabel, useHoverCard } from "./participant-hover-card";

// A clickable reference to another chat message. Authors write `[label](#msg:<id>)` (or a bare
// `#msg:<id>`); we render a link that scrolls the referenced message into view and flashes it.
// This keeps the user-facing text clean instead of leaking raw message ids.

export type MessageFocusHandler = (messageId: string) => boolean | void;

export const MessageLinkContext = createContext<MessageFocusHandler | undefined>(undefined);

function Mention({ handle }: { handle: string }): JSX.Element {
  const directory = useContext(MentionDirectoryContext);
  const profile = directory?.get(handle.toLowerCase());
  const { open, setOpen, openCard, scheduleClose } = useHoverCard();

  if (!profile) {
    return <>{`@${handle}`}</>;
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

export function focusRenderedMessage(root: ParentNode | null | undefined, messageId: string): boolean {
  if (!root || typeof window === "undefined") {
    return false;
  }
  const el = Array.from(root.querySelectorAll<HTMLElement>("[data-message-id]"))
    .find((candidate) => candidate.dataset.messageId === messageId);
  if (!el) {
    return false;
  }
  el.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
  root.querySelectorAll<HTMLElement>(".message-focused")
    .forEach((candidate) => candidate.classList.remove("message-focused"));
  el.classList.add("message-focused");
  el.classList.add("message-flash");
  window.setTimeout(() => el.classList.remove("message-flash"), 1500);
  return true;
}

function MessageLink({ messageId, label }: { messageId: string; label: string }): JSX.Element {
  const focusMessage = useContext(MessageLinkContext);
  const activate = (): void => {
    if (focusMessage?.(messageId) === true) {
      return;
    }
    if (typeof document !== "undefined") {
      focusRenderedMessage(document, messageId);
    }
  };

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

export function MarkdownText({ content }: { content: string }): JSX.Element {
  const blocks = markdownBlocks(content);
  if (blocks.length === 0) {
    return <div className="markdown-text" />;
  }
  return <div className="markdown-text">{blocks.map((block, index) => renderMarkdownBlock(block, index))}</div>;
}

function renderMarkdownBlock(block: MarkdownBlock, index: number): ReactNode {
  if (block.type === "heading") {
    return <h4 key={index}>{renderInlineWithBreaks(block.text, `h-${index}`)}</h4>;
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
          <li key={itemIndex}>{renderInlineWithBreaks(item, `li-${index}-${itemIndex}`)}</li>
        ))}
      </ol>
    );
  }
  if (block.type === "ul") {
    return (
      <ul className="markdown-list" key={index}>
        {block.items.map((item, itemIndex) => (
          <li key={itemIndex}>{renderInlineWithBreaks(item, `li-${index}-${itemIndex}`)}</li>
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
                  {renderInlineWithBreaks(header, `t-${index}-h-${headerIndex}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {block.headers.map((_, cellIndex) => (
                  <td key={cellIndex}>{renderInlineWithBreaks(row[cellIndex] ?? "", `t-${index}-${rowIndex}-${cellIndex}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (block.type === "paragraph") {
    return <p key={index}>{renderInlineWithBreaks(block.lines.join("\n"), `p-${index}`)}</p>;
  }
  return null;
}

function renderInlineWithBreaks(text: string, keyPrefix: string): ReactNode[] {
  return text.split("\n").flatMap((line, index, lines) => {
    const nodes = renderInline(line, `${keyPrefix}-${index}`);
    return index < lines.length - 1 ? [...nodes, <br key={`${keyPrefix}-br-${index}`} />] : nodes;
  });
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return parseMarkdownInline(text).map((node, index) => renderInlineNode(node, `${keyPrefix}-${index}`));
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
    return <code key={key}>{node.text}</code>;
  }
  if (node.type === "mention") {
    return <Mention key={key} handle={node.handle} />;
  }
  if (node.type === "messageLink") {
    return <MessageLink key={key} messageId={node.messageId} label={node.label ?? "↳ message"} />;
  }
  if (node.type === "fileLink") {
    return <FileLink key={key} path={node.path} label={node.label} line={node.line} column={node.column} />;
  }
  if (node.type === "externalLink") {
    return <ExternalLink key={key} url={node.url} label={node.label} />;
  }
  return null;
}

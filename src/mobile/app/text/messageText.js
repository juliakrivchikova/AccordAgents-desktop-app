import { appendSessionsMentions, sessionsMemberChip, sessionsMentionPiecesOf } from "../sessions/sessionsCards.js";
import { sessionsStateState } from "../sessions/sessionsState.js";

export function renderMessageContent(container, markdown) {
  container.textContent = "";
  container.classList.add("markdown-text");
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.trim().startsWith("```")) {
      const language = line.trim().slice(3).trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (language) {
        code.dataset.language = language;
      }
      code.textContent = codeLines.join("\n");
      pre.append(code);
      container.append(pre);
      continue;
    }
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    if (unordered) {
      const list = document.createElement("ul");
      while (index < lines.length) {
        const item = lines[index].match(/^\s*[-*]\s+(.+)$/);
        if (!item) {
          break;
        }
        const li = document.createElement("li");
        appendInlineMarkdown(li, item[1]);
        list.append(li);
        index += 1;
      }
      container.append(list);
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      const list = document.createElement("ol");
      while (index < lines.length) {
        const item = lines[index].match(/^\s*\d+[.)]\s+(.+)$/);
        if (!item) {
          break;
        }
        const li = document.createElement("li");
        appendInlineMarkdown(li, item[1]);
        list.append(li);
        index += 1;
      }
      container.append(list);
      continue;
    }
    const paragraphLines = [];
    while (index < lines.length && lines[index].trim()) {
      if (lines[index].trim().startsWith("```") ||
        /^\s*[-*]\s+/.test(lines[index]) ||
        /^\s*\d+[.)]\s+/.test(lines[index])) {
        break;
      }
      paragraphLines.push(lines[index]);
      index += 1;
    }
    const paragraph = document.createElement("p");
    appendInlineMarkdown(paragraph, paragraphLines.join("\n"));
    container.append(paragraph);
  }
}

function appendInlineMarkdown(parent, text) {
  const source = String(text || "");
  const pattern = /(`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*([^*]+)\*)/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    appendPlainText(parent, source.slice(cursor, match.index));
    if (match[2] !== undefined) {
      // In the sessions view a member's handle in code is its chip, between
      // the code around it; the rest of the code stays as written (the
      // desktop's rule, sessionsMentionPieces).
      const pieces = sessionsMentionPiecesOf(match[2], sessionsStateState.sessionsMentionScope);
      if (!pieces.some(function (piece) { return piece.handle !== undefined; })) {
        const code = document.createElement("code");
        code.textContent = match[2];
        parent.append(code);
      } else {
        pieces.forEach(function (piece) {
          if (piece.handle !== undefined) {
            parent.append(sessionsMemberChip(piece.handle, sessionsStateState.sessionsMentionScope));
          } else if (piece.text.trim()) {
            const code = document.createElement("code");
            code.textContent = piece.text;
            parent.append(code);
          } else {
            parent.append(document.createTextNode(piece.text));
          }
        });
      }
    } else if (match[3] !== undefined) {
      const strong = document.createElement("strong");
      appendPlainText(strong, match[3]);
      parent.append(strong);
    } else if (match[4] !== undefined && match[5] !== undefined) {
      const anchor = document.createElement("a");
      anchor.href = match[5];
      anchor.target = "_blank";
      anchor.rel = "noreferrer";
      appendPlainText(anchor, match[4]);
      parent.append(anchor);
    } else if (match[6] !== undefined) {
      const em = document.createElement("em");
      appendPlainText(em, match[6]);
      parent.append(em);
    }
    cursor = pattern.lastIndex;
  }
  appendPlainText(parent, source.slice(cursor));
}

/** What a member's message shows. The desktop hides the control blocks it
 *  turns into its own controls — the `User choice:` block that becomes the
 *  card below the message — and the phone shows the same message, so it
 *  applies the same rule, from the same shared module rather than a copy of
 *  its own. */
export function displayedMessageText(content, author) {
  const text = typeof content === "string" ? content : "";
  // The desktop applies this to a member's message only: what the User typed
  // is her own words, even when a line of it happens to start "User choice:".
  if (author !== undefined && author !== "agent") {
    return text;
  }
  const shared = self.AccordMobileShared;
  return shared && typeof shared.stripChatControlBlocks === "function"
    ? shared.stripChatControlBlocks(text)
    : text;
}

export function renderMessageContentIfChanged(container, markdown, author) {
  // Compared before the rule runs: reconciling every row on every redraw
  // must not re-strip every message of a long chat to find nothing changed.
  const raw = String(markdown || "");
  // The sessions view draws mentions as its members' chips: a change of
  // who they are (a task's title) draws the text again.
  const rawKey = sessionsStateState.sessionsMentionScope ? raw + "\u0000" + sessionsStateState.sessionsMentionScope.key : raw;
  if (container.dataset.markdownRaw === rawKey) {
    return;
  }
  let source = displayedMessageText(raw, author);
  // A message that is nothing but the block it asked its question with: the
  // card carries the question, and an empty bubble with a timestamp says
  // nothing about what happened. Only when a question was in fact asked —
  // a message that was nothing but "Participant requests: none." asked
  // nothing, and said so wrongly.
  if (!source.trim() && /^\s*user choice\s*:/im.test(raw)) {
    source = "Asked you a question.";
  }
  container.dataset.markdownRaw = rawKey;
  const sourceKey = sessionsStateState.sessionsMentionScope ? source + "\u0000" + sessionsStateState.sessionsMentionScope.key : source;
  if (container.dataset.markdownSource === sourceKey) {
    return;
  }
  renderMessageContent(container, source);
  container.dataset.markdownSource = sourceKey;
}

function appendPlainText(parent, text) {
  const parts = String(text || "").split("\n");
  const scope = sessionsStateState.sessionsMentionScope;
  parts.forEach(function (part, index) {
    if (index > 0) {
      parent.append(document.createElement("br"));
    }
    if (part && scope && part.indexOf("@") >= 0) {
      appendSessionsMentions(parent, part, scope);
    } else if (part) {
      parent.append(document.createTextNode(part));
    }
  });
}

import React from "react";

import type { AvatarSpec } from "../chat/chat-avatars";
import { Avatar, avatarForParticipant } from "../avatar/avatar";
import { MarkdownText } from "../content/markdown-text";
import { typingText } from "./review-conversation-data";

export function TypingIndicator({ labels }: { labels: string[] }): JSX.Element {
  const visibleLabels = labels.length ? labels : ["Models"];
  return (
    <article className="thread-typing" aria-live="polite">
      <Avatar className="thread-avatar typing-avatar" spec={avatarForParticipant(visibleLabels[0])} />
      <div className="typing-bubble">
        <span>{typingText(visibleLabels)}</span>
        <span className="typing-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </div>
    </article>
  );
}

export function ThreadMessage(props: {
  avatar: AvatarSpec;
  author: string;
  meta: string;
  createdAt?: string;
  title?: string;
  content: string;
  badges?: React.ReactNode;
}): JSX.Element {
  return (
    <article className="thread-message">
      <Avatar className="thread-avatar" spec={props.avatar} />
      <div className="thread-bubble">
        <div className="message-meta">
          <strong>{props.author}</strong>
          <span>{props.meta}</span>
          {props.createdAt && <span>{new Date(props.createdAt).toLocaleString()}</span>}
          {props.badges}
        </div>
        {props.title && <h3>{props.title}</h3>}
        <MarkdownText content={props.content} />
      </div>
    </article>
  );
}

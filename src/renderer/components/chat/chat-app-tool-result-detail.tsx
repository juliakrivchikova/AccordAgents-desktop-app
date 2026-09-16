import { useLayoutEffect, useRef, useState } from "react";

/**
 * The one-line detail under a decided card's title. A Codex Auto Review
 * denial carries the whole denied command, so the text is clamped to a few
 * lines and the rest is one click away instead of filling the timeline.
 */
export function ChatAppToolResultDetail({ text }: { text: string }): JSX.Element {
  const textRef = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const element = textRef.current;
    if (expanded || !element) return;
    const measure = (): void => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);
  return (
    <>
      <span ref={textRef} className={`chat-app-tool-result-detail ${expanded ? "" : "is-collapsed"}`}>{text}</span>
      {(expanded || overflowing) && (
        <button
          type="button"
          className="chat-app-tool-result-detail-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

import { useRef } from "react";
import type React from "react";

export function useChatFocusNavigation(options: {
  viewRef: React.RefObject<HTMLDivElement>;
  renderedMessageElement: (messageId: string) => HTMLElement | undefined;
  scrollParentForMessage: (message: HTMLElement) => HTMLElement | undefined;
  alignRenderedMessageToTimelineStart: (messageId: string) => boolean;
  alignRenderedMessageElementToTimelineStart: (message: HTMLElement) => boolean;
  onHandled: (nonce: number) => void;
}): {
  begin: () => void;
  cancel: () => void;
  revealWhenStable: (messageId: string, nonce: number) => void;
} {
  const scheduleIdRef = useRef(0);

  function setActive(active: boolean): void {
    if (active) {
      options.viewRef.current?.setAttribute("data-focus-navigating", "true");
    } else {
      options.viewRef.current?.removeAttribute("data-focus-navigating");
    }
  }

  function begin(): void {
    scheduleIdRef.current += 1;
    setActive(true);
  }

  function cancel(): void {
    scheduleIdRef.current += 1;
    setActive(false);
  }

  function revealWhenStable(messageId: string, nonce: number): void {
    const scheduleId = scheduleIdRef.current + 1;
    scheduleIdRef.current = scheduleId;
    const startedAt = performance.now();
    let lastTop: number | undefined;
    let lastScrollTop: number | undefined;
    let stableFrames = 0;

    const finish = (): void => {
      if (scheduleIdRef.current !== scheduleId) {
        return;
      }
      options.onHandled(nonce);
      setActive(false);
    };
    const sample = (): void => {
      if (scheduleIdRef.current !== scheduleId) {
        return;
      }
      const message = options.renderedMessageElement(messageId);
      const scroller = message ? options.scrollParentForMessage(message) : undefined;
      if (!message || !scroller) {
        if (performance.now() - startedAt >= 1200) {
          finish();
        } else {
          window.requestAnimationFrame(sample);
        }
        return;
      }
      if (message.classList.contains("message-focused")) {
        options.alignRenderedMessageElementToTimelineStart(message);
      } else {
        options.alignRenderedMessageToTimelineStart(messageId);
      }
      const top = message.getBoundingClientRect().top;
      const scrollTop = scroller.scrollTop;
      const stable = lastTop !== undefined && lastScrollTop !== undefined
        && Math.abs(top - lastTop) <= 1
        && Math.abs(scrollTop - lastScrollTop) <= 1;
      stableFrames = stable ? stableFrames + 1 : 0;
      lastTop = top;
      lastScrollTop = scrollTop;
      if (stableFrames >= 6 || performance.now() - startedAt >= 1200) {
        finish();
      } else {
        window.requestAnimationFrame(sample);
      }
    };

    window.requestAnimationFrame(sample);
  }

  return { begin, cancel, revealWhenStable };
}

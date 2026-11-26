import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";

import type { ChatSlashSuggestion } from "./chat-composer-draft-utils";
import { ChatProviderMark } from "./chat-member-mark";
import { providerLabel } from "./chat-conversation-data";
import {
  CHAT_SLASH_NO_TARGET,
  chatSlashUnavailable,
  slashSearchedSummary,
  type ChatSlashItem,
  type ChatSlashTarget,
  type ChatSlashUnavailable
} from "./chat-slash-items";
import { SlashFoldRow, SlashGroupHeader, SlashItemRow } from "./chat-slash-menu-rows";
import type { SlashMenu, SlashMenuNav } from "./slash-menu-model";

export interface ChatSlashMenuProps {
  menu: SlashMenu<ChatSlashSuggestion>;
  activeIndex: number;
  items: readonly ChatSlashItem[];
  query: string;
  /** The search has not answered yet: who the items are for is unknown. */
  searching: boolean;
  target?: ChatSlashTarget;
  onActivate: (nav: number) => void;
  onHover: (nav: number) => void;
}

/** The "/" popup over the composer: one column the composer's width, grouped
 *  by kind, long groups folded (variant A, chosen by the User, 2026-11-26). */
export const ChatSlashMenu = (props: ChatSlashMenuProps) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pointerMovedRef = useRef(false);
  const placement = useComposerPlacement(rootRef);
  const hasTarget = Boolean(props.target);
  const active = props.menu.nav[props.activeIndex];
  const onHover = (nav: number): void => {
    // A row under the pointer is in view already: no scrolling under the hand.
    pointerMovedRef.current = true;
    props.onHover(nav);
  };

  useEffect(() => {
    if (pointerMovedRef.current) {
      pointerMovedRef.current = false;
      return;
    }
    listRef.current
      ?.querySelector<HTMLElement>(`[data-slash-nav="${props.activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeIndex, props.menu.nav.length]);

  return (
    <div
      ref={rootRef}
      className="slash-menu"
      style={placement}
    >
      {props.menu.nav.length === 0
        ? <SlashMenuEmpty query={props.query} items={props.items} />
        : (
          <div ref={listRef} className="slash-menu-list" role="listbox" aria-label="Commands, prompts, skills and plugins">
            {props.menu.rows.map((row) => {
              if (row.type === "header") {
                return <SlashGroupHeader key={`group:${row.kind}`} kind={row.kind} count={row.count} />;
              }
              const events = { nav: row.nav, active: row.nav === props.activeIndex, onActivate: props.onActivate, onHover };
              if (row.type === "item") {
                return (
                  <SlashItemRow
                    key={row.item.key}
                    {...events}
                    item={row.item}
                    match={row.match}
                    unavailable={unavailableFor(row, hasTarget)}
                  />
                );
              }
              return <SlashFoldRow key={`${row.type}:${row.kind}`} {...events} kind={row.kind} count={row.type === "more" ? row.count : undefined} />;
            })}
          </div>
        )}
      <SlashMenuFooter
        unavailable={unavailableFor(active, hasTarget)}
        target={props.target}
        searching={props.searching}
        canInsert={props.menu.nav.length > 0}
      />
    </div>
  );
};

const SlashMenuFooter = (props: { unavailable?: ChatSlashUnavailable; target?: ChatSlashTarget; searching: boolean; canInsert: boolean }) => (
  <div className="slash-menu-footer">
    <span className="slash-menu-footer-lead">
      {props.unavailable
        ? <span className="slash-menu-status is-reason"><i aria-hidden="true" /><span>{props.unavailable.reason}</span></span>
        : props.target ? <SlashMenuFor target={props.target} /> : !props.searching && CHAT_SLASH_NO_TARGET}
    </span>
    <span className="slash-menu-keys" aria-hidden="true">
      {/* With nothing to insert, Enter sends the message: no hint claims otherwise. */}
      {props.canInsert && <span><kbd>↑</kbd><kbd>↓</kbd>Move</span>}
      {props.canInsert && <span><kbd>Enter</kbd>Insert</span>}
      <span><kbd>Esc</kbd>Close</span>
    </span>
  </div>
);

const SlashMenuFor = (props: { target: ChatSlashTarget }) => (
  <span className="slash-menu-for">
    For
    <b>
      {props.target.handles.length > 0
        ? props.target.handles.map((handle) => `@${handle}`).join(", ")
        : props.target.providerKinds.map(providerLabel).join(", ")}
    </b>
    {props.target.providerKinds.map((kind) => <ChatProviderMark key={kind} member={{ kind }} className="is-slash" />)}
  </span>
);

const SlashMenuEmpty = (props: { query: string; items: readonly ChatSlashItem[] }) => {
  const searched = slashSearchedSummary(props.items);
  return (
    <div className="slash-menu-empty" role="status">
      <MagnifyingGlassIcon size={16} aria-hidden="true" />
      <div>
        <div>{props.query ? `No matches for “${props.query}”` : "No commands, prompts, skills or plugins here yet"}</div>
        {props.query && searched && <div className="slash-menu-empty-detail">Searched the names and descriptions of {searched}.</div>}
      </div>
    </div>
  );
};

function unavailableFor(entry: SlashMenuNav<ChatSlashSuggestion> | undefined, hasTarget: boolean): ChatSlashUnavailable | undefined {
  return entry?.type === "item" && entry.item.value.kind === "skill"
    ? chatSlashUnavailable(entry.item.value.item, hasTarget)
    : undefined;
}

// The chat header stays visible above the menu.
const TOP_CLEARANCE = 52;

/** Places the menu over the whole composer card at its width (it lives in
 *  the text field's wrapper, which is narrower and below the card's own
 *  controls), and caps its height to the room above the card, so a composer
 *  in the middle of the window (New chat) never pushes it off the top. */
function useComposerPlacement(ref: RefObject<HTMLElement>): CSSProperties | undefined {
  const [placement, setPlacement] = useState<CSSProperties>();
  useLayoutEffect(() => {
    const anchor = ref.current?.offsetParent;
    const card = ref.current?.closest(".chat-composer-shell") ?? anchor;
    if (!anchor || !card) {
      return;
    }
    const measure = (): void => {
      const field = anchor.getBoundingClientRect();
      const box = card.getBoundingClientRect();
      setPlacement({
        "--slash-menu-lift": `${Math.round(field.top - box.top)}px`,
        "--slash-menu-inset-left": `${Math.round(field.left - box.left)}px`,
        "--slash-menu-inset-right": `${Math.round(box.right - field.right)}px`,
        // No floor: a tall terminal can leave little room, and a taller menu
        // would be cut off by the chat pane.
        "--slash-menu-room": `${Math.max(0, Math.floor(box.top - TOP_CLEARANCE))}px`
      } as CSSProperties);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref]);
  return placement;
}

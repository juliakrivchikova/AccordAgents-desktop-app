import { forwardRef, useRef, type ComponentPropsWithoutRef } from "react";
import {
  ArrowsInSimpleIcon,
  CaretDownIcon,
  CaretUpIcon,
  FileTextIcon,
  LightningIcon,
  PlugIcon,
  TargetIcon
} from "@phosphor-icons/react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ChatProviderKind } from "../../../shared/types";
import type { ChatSlashSuggestion } from "./chat-composer-draft-utils";
import { ChatProviderMark, ChatProviderMarkSlot } from "./chat-member-mark";
import { chatSlashProviderKinds, slashKindCount, SLASH_KIND_TITLES, type ChatSlashUnavailable } from "./chat-slash-items";
import type { SlashKind, SlashMatch, SlashMenuItem } from "./slash-menu-model";

// Fixed columns, so a column of marks reads as "works in" (the User, variant A).
const PROVIDER_COLUMNS: readonly ChatProviderKind[] = ["claude-code", "codex-cli", "gemini-cli"];

interface RowEvents {
  nav: number;
  active: boolean;
  onActivate: (nav: number) => void;
  onHover: (nav: number) => void;
}

export const SlashGroupHeader = (props: { kind: SlashKind; count: number }) => (
  <div className="slash-menu-group" role="presentation">
    <span>{SLASH_KIND_TITLES[props.kind]}</span>
    <span className="slash-menu-group-count">{props.count}</span>
  </div>
);

export const SlashItemRow = (props: RowEvents & {
  item: SlashMenuItem<ChatSlashSuggestion>;
  match: SlashMatch;
  unavailable?: ChatSlashUnavailable;
}) => {
  const descriptionRef = useRef<HTMLSpanElement>(null);
  const { item, unavailable } = props;
  const tooltip = unavailable?.reason ?? item.description;
  // The tooltip adds only what the row cannot show: a cut description, or
  // why the item cannot be inserted.
  const wantsTooltip = (): boolean => {
    const description = descriptionRef.current;
    return Boolean(unavailable) || Boolean(tooltip && description && description.scrollWidth > description.clientWidth + 1);
  };
  return (
    <Tooltip>
      {/* A row that wants no tooltip stops the pointer before the kit tooltip
          sees it: a refused open would still switch the app's tooltips to
          opening without their delay. */}
      <TooltipTrigger asChild onPointerMove={(event) => {
        if (!wantsTooltip()) {
          event.preventDefault();
        }
      }}>
        <SlashRowButton nav={props.nav} active={props.active} onActivate={props.onActivate} onHover={props.onHover} tone={item.disabled ? "unavailable" : "item"}>
          <span className="slash-menu-icon">{slashItemIcon(item.value)}</span>
          <span className="slash-menu-name">
            <span className="slash-menu-slash">/</span>
            <SlashName name={item.name} marked={props.match.name} />
          </span>
          <span className="slash-menu-desc" ref={descriptionRef}>
            <SlashDescription text={item.description} span={props.match.description} />
          </span>
          {unavailable?.short && (
            <span className="slash-menu-status"><i aria-hidden="true" />{unavailable.short}</span>
          )}
          <SlashProviderMarks kinds={chatSlashProviderKinds(item.value)} />
        </SlashRowButton>
      </TooltipTrigger>
      {/* Over the menu, which sits above popovers. */}
      <TooltipContent side="top" align="start" className="z-(--z-overlay)">{tooltip}</TooltipContent>
    </Tooltip>
  );
};

export const SlashFoldRow = (props: RowEvents & { kind: SlashKind; count?: number }) => (
  <SlashRowButton nav={props.nav} active={props.active} onActivate={props.onActivate} onHover={props.onHover} tone="fold">
    <span className="slash-menu-icon">{props.count === undefined ? <CaretUpIcon size={14} /> : <CaretDownIcon size={14} />}</span>
    <span className="slash-menu-name">
      {props.count === undefined ? "Show fewer" : `Show all ${slashKindCount(props.kind, props.count)}`}
    </span>
  </SlashRowButton>
);

type RowTone = "item" | "unavailable" | "fold";

// Forwards its ref: the kit Tooltip anchors on the row it wraps.
const SlashRowButton = forwardRef<HTMLButtonElement, RowEvents & ComponentPropsWithoutRef<"button"> & { tone: RowTone }>(
  (props, ref) => {
    const { nav, active, onActivate, onHover, tone, children, ...rest } = props;
    return (
      <button
        {...rest}
        ref={ref}
        type="button"
        // The composer keeps the focus: arrows and Enter go through it.
        tabIndex={-1}
        role="option"
        aria-selected={active}
        aria-disabled={tone === "unavailable" || undefined}
        data-slash-nav={nav}
        className={["slash-menu-row", active ? "is-active" : "", tone === "item" ? "" : `is-${tone}`].filter(Boolean).join(" ")}
        onMouseDown={(event) => {
          event.preventDefault();
          onActivate(nav);
        }}
        onMouseMove={() => {
          if (!active) {
            onHover(nav);
          }
        }}
      >
        {children}
      </button>
    );
  }
);
SlashRowButton.displayName = "SlashRowButton";

const SlashName = (props: { name: string; marked: readonly number[] }) => {
  const marked = new Set(props.marked);
  const namespaceEnd = props.name.indexOf(":") + 1;
  const runs: Array<{ text: string; marked: boolean; namespace: boolean }> = [];
  for (let index = 0; index < props.name.length; index += 1) {
    const run = { marked: marked.has(index), namespace: index < namespaceEnd };
    const last = runs[runs.length - 1];
    if (last && last.marked === run.marked && last.namespace === run.namespace) {
      last.text += props.name[index];
    } else {
      runs.push({ ...run, text: props.name[index] });
    }
  }
  return (
    <>
      {runs.map((run, index) => {
        const text = run.marked ? <b>{run.text}</b> : run.text;
        return run.namespace ? <span key={index} className="slash-menu-namespace">{text}</span> : <span key={index}>{text}</span>;
      })}
    </>
  );
};

const SlashDescription = (props: { text: string; span?: readonly [number, number] }) => {
  if (!props.span) {
    return <>{props.text}</>;
  }
  const [start, end] = props.span;
  return <>{props.text.slice(0, start)}<b>{props.text.slice(start, end)}</b>{props.text.slice(end)}</>;
};

const SlashProviderMarks = (props: { kinds: readonly ChatProviderKind[] }) => (
  <span className="slash-menu-marks">
    {PROVIDER_COLUMNS.map((kind) => props.kinds.includes(kind)
      ? <ChatProviderMark key={kind} member={{ kind }} className="is-slash" />
      : <ChatProviderMarkSlot key={kind} />)}
  </span>
);

function slashItemIcon(option: ChatSlashSuggestion): JSX.Element {
  if (option.kind === "command") {
    return option.item.id === "goal" ? <TargetIcon size={14} /> : <ArrowsInSimpleIcon size={14} />;
  }
  if (option.kind === "prompt") {
    return <FileTextIcon size={14} />;
  }
  if (option.kind === "skill") {
    return <LightningIcon size={14} />;
  }
  return option.item.iconUrl ? <img src={option.item.iconUrl} alt="" aria-hidden="true" /> : <PlugIcon size={14} />;
}

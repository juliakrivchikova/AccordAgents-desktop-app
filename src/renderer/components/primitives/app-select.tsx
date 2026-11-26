import type * as React from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";

export interface AppSelectOption {
  value: string;
  label: string;
  /** Shown before the label, in the list and in the closed select. */
  icon?: React.ReactNode;
  disabled?: boolean;
}

/** Radix takes no empty value for an item: an option whose value is "" (a
 *  "Default" or "Do not check") travels under this one inside the select. */
const EMPTY_VALUE = "__app-select-empty__";

export function AppSelect(props: {
  value: string;
  options: AppSelectOption[];
  placeholder: string;
  disabled?: boolean;
  /** "sm" is the 28px control of a settings row. */
  size?: "sm" | "default";
  /** "ghost" sits in a line of text (a member's inline settings). */
  variant?: "default" | "ghost";
  /** Text before the value inside the control ("Run on:"). */
  prefix?: React.ReactNode;
  /** Shown instead of the chosen option's label. */
  valueLabel?: React.ReactNode;
  /** For a <label htmlFor> outside the control. */
  id?: string;
  className?: string;
  ariaLabel?: string;
  testId?: string;
  onValueChange: (value: string) => void;
}): JSX.Element {
  const hasEmptyOption = props.options.some((option) => option.value === "");
  const selectedValue = props.value === "" && hasEmptyOption ? EMPTY_VALUE : props.value || undefined;
  return (
    <Select
      value={selectedValue}
      disabled={props.disabled}
      onValueChange={(value) => props.onValueChange(value === EMPTY_VALUE ? "" : value)}
    >
      {/* app-select-trigger carries the boxed field's legacy sizes (a 28px minimum,
          a 206px minimum in settings rows): never on the inline ghost variant. */}
      <SelectTrigger id={props.id} size={props.size} variant={props.variant} className={`${props.variant === "ghost" ? "" : "app-select-trigger "}${props.className ?? ""}`} aria-label={props.ariaLabel ?? props.placeholder} data-testid={props.testId}>
        {props.prefix && <span className="shrink-0 text-ui-text-3">{props.prefix}</span>}
        {/* A long value (a machine, a model id) ends in an ellipsis, not past the caret. */}
        <SelectValue placeholder={props.placeholder}>{props.valueLabel === undefined ? undefined : <span className="min-w-0 truncate">{props.valueLabel}</span>}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {props.options.map((option) => (
            <SelectItem value={option.value || EMPTY_VALUE} textValue={option.label} disabled={props.disabled || option.disabled} key={option.value || EMPTY_VALUE}>
              {/* Typing a name finds the option, and it is read out once. */}
              {option.icon && <span aria-hidden="true" className="inline-flex shrink-0 text-ui-text-3">{option.icon}</span>}
              <span className="min-w-0 truncate">{option.label}</span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

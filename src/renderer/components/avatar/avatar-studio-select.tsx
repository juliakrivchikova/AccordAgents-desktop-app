import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** A compact toolbar select: the app's menu, without the settings-table row around it. */
export function StudioSelect(props: {
  label: string;
  value: string;
  display: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  onSelect: (value: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="avatar-studio-chip"
          aria-label={`Change ${props.label}`}
          disabled={props.disabled}
        >
          <span>{props.display}</span>
          <ChevronDown size={13} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="chat-app-tool-inline-menu">
        {props.options.map((option) => (
          <button
            type="button"
            key={option.value || "default"}
            className={`chat-app-tool-inline-option${option.value === props.value ? " selected" : ""}`}
            onClick={() => {
              props.onSelect(option.value);
              setOpen(false);
            }}
          >
            <span>{option.label}</span>
            {option.value === props.value && <Check size={14} aria-hidden />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

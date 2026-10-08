import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

import { writeClipboardText, type ClipboardWriteResult } from "../../../shared/clipboard";
import { IconButton, type IconButtonSize } from "./icon-button";

const FEEDBACK_MS = 1500;

// The copy control for text shown beside it: a bare icon with a "Copy"
// tooltip, no border and no text. After a copy the icon turns into a check for
// a moment and a screen reader hears "Copied"; a failed copy says so in the
// tooltip and in the accessible label.
export function CopyButton(props: {
  text: string | undefined;
  label: string;
  size?: IconButtonSize;
  className?: string;
  disabled?: boolean;
  onCopied?: (result: ClipboardWriteResult) => void;
  "data-testid"?: string;
}): JSX.Element {
  const [result, setResult] = useState<ClipboardWriteResult>();
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(undefined), FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [result]);
  const copy = async (): Promise<void> => {
    if (!props.text) return;
    const next = await writeClipboardText(props.text, (value) => navigator.clipboard.writeText(value));
    setResult(next);
    props.onCopied?.(next);
  };
  const tooltip = result === "copied" ? "Copied" : result === "failed" ? "Copy failed" : "Copy";
  return (
    <>
      <IconButton
        icon={result === "copied" ? Check : Copy}
        label={result === "failed" ? `${props.label}: copy failed` : props.label}
        tooltip={tooltip}
        size={props.size}
        className={props.className}
        disabled={props.disabled || !props.text}
        data-copy-state={result ?? "idle"}
        data-testid={props["data-testid"]}
        onClick={() => void copy()}
      />
      <span className="sr-only" aria-live="polite">{result === "copied" ? "Copied" : ""}</span>
    </>
  );
}

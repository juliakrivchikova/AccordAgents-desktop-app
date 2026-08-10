import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Copy, Info, Pencil } from "lucide-react";

import { MarkdownText } from "../content/markdown-text";
import { IconButton } from "../primitives/icon-button";

export function ArtifactContentSurface(props: {
  content: string;
  testId: string;
  note?: string;
  onRevise?: () => void;
  reviseDisabled?: boolean;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(resetRef.current), []);
  useEffect(() => {
    setCopied(false);
    window.clearTimeout(resetRef.current);
  }, [props.content]);

  function copyContent(): void {
    void navigator.clipboard.writeText(props.content).then(() => {
      setCopied(true);
      window.clearTimeout(resetRef.current);
      resetRef.current = window.setTimeout(() => setCopied(false), 1600);
    });
  }

  return (
    <div className="artifact-content-surface" data-testid={props.testId}>
      <div className="artifact-content-fabs">
        {props.onRevise && (
          <IconButton
            className="artifact-content-action"
            icon={Pencil}
            label="Revise"
            tooltip="Revise"
            size="xs"
            variant="ghost"
            disabled={props.reviseDisabled}
            onClick={props.onRevise}
          />
        )}
        <IconButton
          className="artifact-content-action artifact-content-copy"
          icon={copied ? CheckCircle2 : Copy}
          label={copied ? "Copied" : "Copy content"}
          tooltip={copied ? "Copied" : "Copy content"}
          size="xs"
          variant="ghost"
          data-testid="artifact-copy-content"
          onClick={copyContent}
        />
      </div>
      <div className="artifact-content-markdown">
        <MarkdownText content={props.content} />
        {props.note ? (
          <div className="artifact-version-note">
            <Info size={14} aria-hidden />
            <span><strong>Note</strong> — {props.note}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

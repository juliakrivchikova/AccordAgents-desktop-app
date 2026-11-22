import { useEffect, useRef, useState } from "react";
import { SealCheckIcon, CheckCircleIcon, CopyIcon, InfoIcon, PencilSimpleIcon } from "@phosphor-icons/react";

import { MarkdownText } from "../content/markdown-text";
import { IconButton } from "../primitives/icon-button";

export function ArtifactContentSurface(props: {
  content: string;
  testId: string;
  note?: string;
  onRevise?: () => void;
  reviseDisabled?: boolean;
  signLabel?: string;
  onSign?: () => void;
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
    <div className={`artifact-content-surface${props.onSign ? " has-sign" : ""}`} data-testid={props.testId}>
      <div className="artifact-content-fabs">
        {props.onSign && (
          <IconButton
            icon={SealCheckIcon}
            label={props.signLabel ?? "Sign"}
            tooltip={props.signLabel ?? "Sign"}
            floating
            disabled={props.reviseDisabled}
            data-testid="artifact-sign-shortcut"
            onClick={props.onSign}
          />
        )}
        {props.onRevise && (
          <IconButton
            icon={PencilSimpleIcon}
            label="Revise"
            tooltip="Revise"
            floating
            disabled={props.reviseDisabled}
            onClick={props.onRevise}
          />
        )}
        <IconButton
          icon={copied ? CheckCircleIcon : CopyIcon}
          label={copied ? "Copied" : "Copy content"}
          tooltip={copied ? "Copied" : "Copy content"}
          floating
          data-testid="artifact-copy-content"
          onClick={copyContent}
        />
      </div>
      <div className="artifact-content-markdown">
        <MarkdownText content={props.content} />
        {props.note ? (
          <div className="artifact-version-note">
            <InfoIcon size={14} aria-hidden />
            <span><strong>Note</strong> — {props.note}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

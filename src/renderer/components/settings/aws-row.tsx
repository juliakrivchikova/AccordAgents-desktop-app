import type { ReactNode } from "react";

/** A settings row: title, a muted line or a red one, and one action. The red
 *  line is the row's standing state, so it is not announced as an alert. */
export function Row(props: {
  title: ReactNode;
  desc?: ReactNode;
  error?: ReactNode;
  action?: { label: string; onClick: () => void; disabled?: boolean; testId?: string };
  testId?: string;
}): JSX.Element {
  return (
    <div className="gen-row" data-testid={props.testId}>
      <div className="gen-row-text">
        <div className="gen-row-title">{props.title}</div>
        {props.desc ? <div className="gen-row-desc">{props.desc}</div> : null}
        {props.error ? <div className="gen-row-error">{props.error}</div> : null}
      </div>
      {props.action ? (
        <div className="gen-actions">
          <button type="button" className="gen-pill" data-testid={props.action.testId} disabled={props.action.disabled} onClick={props.action.onClick}>
            <span className="gen-pill-label">{props.action.label}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

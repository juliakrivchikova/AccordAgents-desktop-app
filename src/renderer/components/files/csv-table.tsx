import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { FILE_PREVIEW_CSV_COLUMN_LIMIT, csvDelimiterForPath, parseCsv } from "../../../shared/filePreview";

/** Must match --file-csv-row-height in file-panel.css. */
const ROW_HEIGHT = 28;
const INDEX_COLUMN_PX = 56;
const CHAR_PX = 7.2;
const MIN_COLUMN_PX = 72;
const MAX_COLUMN_PX = 320;
/** Column widths come from this many rows. */
const WIDTH_SAMPLE_ROWS = 200;

/**
 * A CSV or TSV file as a table: the first row is the header and stays on top,
 * rows are virtualized, so a file of 100 000 rows scrolls like a short one.
 * Editing happens in the text view.
 */
export function CsvTable(props: { text: string; filename: string; partial: boolean }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const parsed = useMemo(() => {
    const delimiter = csvDelimiterForPath(props.filename, props.text.slice(0, 4096));
    return parseCsv(props.text, delimiter);
  }, [props.filename, props.text]);
  const header = parsed.rows[0] ?? [];
  const body = parsed.rows.slice(1);
  const allColumns = Math.max(parsed.columnCount, header.length);
  const columns = Math.min(allColumns, FILE_PREVIEW_CSV_COLUMN_LIMIT);
  const virtualizer = useVirtualizer({
    count: body.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20
  });
  // Every row is its own grid, so columns get fixed widths from the first rows' content.
  const template = useMemo(() => {
    const sample = parsed.rows.slice(0, WIDTH_SAMPLE_ROWS);
    const widths = Array.from({ length: Math.max(columns, 1) }, (_, index) => {
      const longest = sample.reduce((max, row) => Math.max(max, (row[index] ?? "").length), 0);
      return Math.min(MAX_COLUMN_PX, Math.max(MIN_COLUMN_PX, Math.round(longest * CHAR_PX + 20)));
    });
    return `${INDEX_COLUMN_PX}px ${widths.map((width) => `${width}px`).join(" ")}`;
  }, [columns, parsed.rows]);

  if (parsed.rows.length === 0) {
    return <p className="file-panel-message">This table is empty.</p>;
  }

  return (
    <div className="file-csv">
      {(parsed.truncated || props.partial || allColumns > columns) && (
        <p className="file-panel-note">
          {[
            parsed.truncated ? `Showing the first ${body.length.toLocaleString()} rows.` : props.partial ? "Showing the start of a large file." : "",
            allColumns > columns ? `Showing ${columns} of ${allColumns} columns.` : ""
          ].filter(Boolean).join(" ")}
        </p>
      )}
      <div
        ref={scrollRef}
        className="file-csv-scroll"
        data-testid="file-csv-table"
        role="table"
        aria-rowcount={body.length + 1}
      >
        <div className="file-csv-row file-csv-header" role="row" aria-rowindex={1} style={{ gridTemplateColumns: template }}>
          <span className="file-csv-index" role="columnheader" aria-label="Row" />
          {Array.from({ length: columns }, (_, index) => (
            <span key={index} className="file-csv-cell" role="columnheader" title={header[index] ?? ""}>{header[index] ?? ""}</span>
          ))}
        </div>
        <div className="file-csv-body" role="rowgroup" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = body[item.index] ?? [];
            return (
              <div
                key={item.key}
                className="file-csv-row"
                role="row"
                aria-rowindex={item.index + 2}
                style={{ gridTemplateColumns: template, transform: `translateY(${item.start}px)` }}
              >
                <span className="file-csv-index" role="rowheader">{item.index + 2}</span>
                {Array.from({ length: columns }, (_, index) => (
                  <span key={index} className="file-csv-cell" role="cell" title={row[index] ?? ""}>{row[index] ?? ""}</span>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

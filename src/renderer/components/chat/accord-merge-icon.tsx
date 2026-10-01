// The Start Accord glyph: a merge whose branches keep their own colors, so it
// ignores currentColor.
export function AccordMergeIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      className={className}
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m8 6 4-4 4 4" stroke="var(--app-accord-icon-top)" />
      <path d="M12 2v10.3" stroke="var(--app-accord-icon-top)" />
      <path d="M12 12.3a4 4 0 0 1-1.172 2.872L4 22" stroke="var(--app-accord-icon-left)" />
      <path d="m20 22-5-5" stroke="var(--app-accord-icon-right)" />
    </svg>
  );
}

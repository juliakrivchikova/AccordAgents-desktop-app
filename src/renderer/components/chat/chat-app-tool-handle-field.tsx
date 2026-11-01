export function ChatAppToolHandleField(props: { handle: string; onChange: (handle: string) => void }): JSX.Element {
  return (
    <span className="chat-app-tool-inline-handle">
      <span aria-hidden>@</span>
      <input
        value={props.handle}
        aria-label="Member handle"
        spellCheck={false}
        size={Math.max(props.handle.length + 1, 4)}
        onChange={(event) => props.onChange(event.currentTarget.value.replace(/^@+/, ""))}
      />
    </span>
  );
}

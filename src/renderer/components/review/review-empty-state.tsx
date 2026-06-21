import { HelpCircle } from "lucide-react";

export function EmptyState({ title, body }: { title: string; body: string }): JSX.Element {
  return (
    <div className="empty-state">
      <HelpCircle size={26} />
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}

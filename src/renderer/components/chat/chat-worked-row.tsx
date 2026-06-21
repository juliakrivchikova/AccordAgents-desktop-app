import { Sparkles } from "lucide-react";

export function WorkedRow({ workedMs }: { workedMs: number }): JSX.Element {
  return (
    <div className="chat-worked-wrap">
      <div className="chat-worked">
        <Sparkles size={13} aria-hidden />
        <span>Worked for {formatWorkedDuration(workedMs)}</span>
      </div>
    </div>
  );
}

function formatWorkedDuration(workedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(workedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

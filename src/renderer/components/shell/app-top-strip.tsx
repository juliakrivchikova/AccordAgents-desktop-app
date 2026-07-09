import { ArrowLeft, ArrowRight } from "lucide-react";
import { ModeToggle } from "../mode-toggle";

export function AppTopStrip(): JSX.Element {
  return (
    <div className="app-top-strip">
      <div className="app-top-strip-lights" aria-hidden="true">
        <span className="app-top-strip-light app-top-strip-light-red" />
        <span className="app-top-strip-light app-top-strip-light-yellow" />
        <span className="app-top-strip-light app-top-strip-light-green" />
      </div>
      <nav className="app-top-strip-navigation" aria-label="History">
        <button
          type="button"
          className="app-top-strip-button"
          title="Back"
          aria-label="Back"
          onClick={() => window.history.back()}
        >
          <ArrowLeft aria-hidden="true" size={17} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="app-top-strip-button"
          title="Forward"
          aria-label="Forward"
          onClick={() => window.history.forward()}
        >
          <ArrowRight aria-hidden="true" size={17} strokeWidth={1.75} />
        </button>
      </nav>
      <span className="app-top-strip-spacer" />
      <ModeToggle />
    </div>
  );
}

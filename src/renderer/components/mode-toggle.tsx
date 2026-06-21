import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip";
import { useTheme } from "./theme-provider";

export function ModeToggle(): JSX.Element {
  const { theme, toggleTheme } = useTheme();
  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          data-testid="theme-toggle"
          variant="ghost"
          size="icon-sm"
          className="topbar-icon-button"
          title={label}
          onClick={toggleTheme}
        >
          {theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
          <span className="sr-only">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{theme === "dark" ? "Light theme" : "Dark theme"}</TooltipContent>
    </Tooltip>
  );
}

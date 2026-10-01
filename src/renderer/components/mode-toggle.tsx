import { Moon, Sun } from "lucide-react";

import { IconButton } from "./primitives";
import { useTheme } from "./theme-provider";

export function ModeToggle(): JSX.Element {
  const { theme, toggleTheme } = useTheme();
  return (
    <IconButton
      data-testid="theme-toggle"
      label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      icon={theme === "dark" ? Sun : Moon}
      tooltip={theme === "dark" ? "Light theme" : "Dark theme"}
      onClick={toggleTheme}
    />
  );
}

import * as React from "react";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface FormRowProps extends React.ComponentProps<"div"> {
  label?: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  optional?: boolean;
  orientation?: "vertical" | "horizontal";
}

export const FormRow = ({
  label,
  htmlFor,
  hint,
  optional,
  orientation = "vertical",
  className,
  children,
  ...rest
}: FormRowProps): JSX.Element => (
  <div
    data-slot="form-row"
    className={cn(
      orientation === "vertical" ? "flex flex-col gap-2" : "flex items-center gap-3",
      className
    )}
    {...rest}
  >
    {label !== undefined && (
      <Label
        htmlFor={htmlFor}
        className="text-[11.5px] font-semibold leading-none tracking-[0.01em] text-muted-foreground"
      >
        <span>{label}</span>
        {optional ? (
          <span className="ml-1 text-[10px] font-normal normal-case tracking-normal text-muted-foreground/70">
            optional
          </span>
        ) : null}
      </Label>
    )}
    {children}
    {hint !== undefined && (
      <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
    )}
  </div>
);

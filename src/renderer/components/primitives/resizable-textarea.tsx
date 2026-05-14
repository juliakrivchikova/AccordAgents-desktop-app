import * as React from "react";

import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export interface ResizableTextareaProps
  extends Omit<React.ComponentProps<"textarea">, "style"> {
  maxHeight?: number;
  minRows?: number;
  style?: React.CSSProperties;
}

export const ResizableTextarea = React.forwardRef<HTMLTextAreaElement, ResizableTextareaProps>(
  function ResizableTextarea(
    { className, maxHeight, minRows, style, rows, ...rest },
    ref
  ) {
    const composedStyle: React.CSSProperties = {
      ...style,
      ...(maxHeight ? { maxHeight: `${maxHeight}px` } : undefined)
    };
    const effectiveRows = rows ?? minRows;
    return (
      <Textarea
        ref={ref}
        rows={effectiveRows}
        style={composedStyle}
        className={cn(
          "resize-none overflow-y-auto",
          maxHeight ? "overflow-y-auto" : undefined,
          className
        )}
        {...rest}
      />
    );
  }
);

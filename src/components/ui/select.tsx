import * as React from "react"
import { Select as SelectPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { CaretDownIcon, CheckIcon, CaretUpIcon } from "@phosphor-icons/react";

function Select({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />
}

function SelectGroup({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("scroll-my-1 p-1", className)}
      {...props}
    />
  )
}

function SelectValue({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

function SelectTrigger({
  className,
  size = "default",
  variant = "default",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: "sm" | "default"
  /** "ghost": the value and its caret in a line of text, no box (a member's
   *  inline settings); the list it opens is the same. */
  variant?: "default" | "ghost"
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "flex w-fit max-w-full min-w-0 items-center rounded-ui-8 text-ui-13 whitespace-nowrap outline-none select-none disabled:cursor-not-allowed disabled:opacity-50 data-placeholder:text-muted-foreground *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        variant === "ghost"
          ? "h-6 gap-1 border border-transparent bg-transparent px-1.5 text-ui-text-2 transition-colors duration-120 ease-ui-out enabled:hover:bg-ui-row-hover enabled:hover:text-ui-text data-[state=open]:bg-ui-row-hover data-[state=open]:text-ui-text focus-visible:ring-2 focus-visible:ring-ui-focus-ring"
          : "justify-between gap-2 border border-ui-border bg-ui-bg py-1 pr-2 pl-2.5 transition-[border-color,box-shadow] duration-120 ease-ui-out hover:border-ui-border-strong data-[state=open]:border-ui-primary focus-visible:border-ui-primary focus-visible:ring-3 focus-visible:ring-ui-focus aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-7 data-[size=sm]:h-6 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <CaretDownIcon className={cn("pointer-events-none text-ui-text-3", variant === "ghost" ? "size-3" : "size-4")} />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  position = "popper",
  align = "start",
  sideOffset = 4,
  onMouseDown,
  onKeyDown,
  onEscapeKeyDown,
  onPointerDownOutside,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      {/* The list is in a portal on body, outside the popup that opened it (a
          menu, a form): its presses and keys stop here, so that popup's
          outside-press and Escape handlers never close it under the list.
          Escape is stopped where Radix closes the list (its own capture
          listener on the document): by the time it would bubble here the list
          is already gone and its handlers no longer run. The press that closes
          the list from outside is the list's too: while it is open the page
          takes no pointer events, so that press lands on the document root and
          would read as a press outside the popup under it. Shortcuts with a
          modifier (Cmd+K) still reach the window. */}
      <SelectPrimitive.Content
        data-slot="select-content"
        onMouseDown={(event) => { event.stopPropagation(); onMouseDown?.(event); }}
        onKeyDown={(event) => {
          if (!event.metaKey && !event.ctrlKey && !event.altKey) event.stopPropagation();
          onKeyDown?.(event);
        }}
        onEscapeKeyDown={(event) => { event.stopPropagation(); onEscapeKeyDown?.(event); }}
        onPointerDownOutside={(event) => { event.detail.originalEvent.preventDefault(); onPointerDownOutside?.(event); }}
        data-align-trigger={position === "item-aligned"}
        className={cn("relative z-(--z-menu) max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-ui-12 bg-ui-elevated p-1 text-ui-text shadow-ui-md duration-150 ease-ui-out data-[align-trigger=true]:animate-none data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95", className )}
        position={position}
        align={align}
        sideOffset={sideOffset}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          data-position={position}
          className={cn(
            "data-[position=popper]:h-(--radix-select-trigger-height) data-[position=popper]:w-full data-[position=popper]:min-w-(--radix-select-trigger-width)",
            position === "popper" && ""
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn("px-1.5 py-1 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-ui-8 py-1.5 pr-8 pl-2 text-ui-13 outline-hidden select-none transition-colors duration-120 ease-ui-out focus:bg-ui-row-hover data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center text-ui-text">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="pointer-events-none" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none -mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn(
        "z-10 flex cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <CaretUpIcon
      />
    </SelectPrimitive.ScrollUpButton>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn(
        "z-10 flex cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <CaretDownIcon
      />
    </SelectPrimitive.ScrollDownButton>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}

import React from "react";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import "./ui.css";

/**
 * Props for the shared {@link TooltipProvider} — a thin wrapper over Radix
 * `Tooltip.Provider`. Mount once at the app root so every {@link Tooltip} shares
 * one delay group (the first tooltip waits `delayDuration`; subsequent ones in
 * the same group open immediately while the group stays "warm").
 */
export interface TooltipProviderProps {
  /** Time in ms the pointer must rest before the first tooltip opens. */
  delayDuration?: number;
  /** How long the group stays warm after a tooltip closes (ms). */
  skipDelayDuration?: number;
  children: React.ReactNode;
}

/**
 * App-wide tooltip delay group. Mount once near {@link ToastProvider} at the app
 * root; individual {@link Tooltip}s do not need their own provider.
 */
export function TooltipProvider({
  delayDuration = 400,
  skipDelayDuration = 200,
  children,
}: TooltipProviderProps): React.ReactElement {
  return (
    <RadixTooltip.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration}>
      {children}
    </RadixTooltip.Provider>
  );
}

/**
 * Props for the shared {@link Tooltip} primitive — a token-styled skin over
 * `@radix-ui/react-tooltip`. Wraps a single focusable trigger child and reveals
 * `content` on hover/focus with correct `role="tooltip"` / `aria-describedby`
 * wiring from Radix.
 *
 * A tooltip is **not** an accessible name: keep an `aria-label` on the trigger
 * when the visible name is only conveyed through the tooltip.
 */
export interface TooltipProps {
  /** The hover/focus help text (string or rich node). */
  content: React.ReactNode;
  /** The single focusable element the tooltip describes. */
  children: React.ReactElement;
  /** Preferred side of the trigger to render on. Defaults to `"right"`. */
  side?: RadixTooltip.TooltipContentProps["side"];
  /** Alignment along the chosen side. Defaults to `"center"`. */
  align?: RadixTooltip.TooltipContentProps["align"];
  /** Gap in px between trigger and tooltip. Defaults to `6`. */
  sideOffset?: number;
  /** Disable the tooltip without unmounting the trigger. */
  disabled?: boolean;
  /** Test hook forwarded to the tooltip content. */
  "data-testid"?: string;
}

/**
 * The single shared tooltip primitive. Prefer this over a bare `title=`
 * attribute so hover help is consistent, themed, and keyboard/focus accessible.
 * Relies on a {@link TooltipProvider} mounted once at the app root.
 */
export function Tooltip({
  content,
  children,
  side = "right",
  align = "center",
  sideOffset = 6,
  disabled,
  ...rest
}: TooltipProps): React.ReactElement {
  if (disabled) {
    return children;
  }

  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          className="ui-tooltip__content"
          side={side}
          align={align}
          sideOffset={sideOffset}
          data-testid={rest["data-testid"]}
        >
          {content}
          <RadixTooltip.Arrow className="ui-tooltip__arrow" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

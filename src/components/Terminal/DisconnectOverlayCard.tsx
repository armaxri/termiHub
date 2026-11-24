import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Tooltip, TOAST_AVOID_PROPS } from "@/components/ui";

interface DisconnectOverlayCardProps {
  /** Dismisses the overlay and shows the scrollback. */
  onDismiss: () => void;
  /** Accessible name of the dismiss control. */
  dismissLabel?: string;
  /** The overlay body (a `ContentOverlay`). */
  children: ReactNode;
}

/**
 * The disconnect overlay's card (#5619): the body and its dismiss control sit
 * together, so the "x" belongs to the notice instead of floating alone at the
 * pane's corner, and it says what it does in a tooltip.
 *
 * The card, not the pane-sized overlay around it, is the toast keep-clear zone
 * (#5904): the overlay covers the whole pane, so marking it docked the toast
 * stack and held back every success toast (a tab's "Closed … · Reopen" undo
 * among them) for as long as an ended session showed anywhere.
 */
export function DisconnectOverlayCard({
  onDismiss,
  dismissLabel = "Dismiss and view scrollback",
  children,
}: DisconnectOverlayCardProps) {
  return (
    <div className="terminal-disconnect-overlay__card" {...TOAST_AVOID_PROPS}>
      <Tooltip content="Dismiss" side="bottom">
        <button
          type="button"
          className="terminal-disconnect-overlay__dismiss"
          onClick={onDismiss}
          aria-label={dismissLabel}
          data-testid="terminal-disconnect-dismiss-btn"
        >
          <X size={14} />
        </button>
      </Tooltip>
      {children}
    </div>
  );
}

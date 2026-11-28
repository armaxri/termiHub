import { useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { TOAST_AVOID_PROPS, Tooltip } from "@/components/ui";
import { useTopNoticeInset } from "./topNoticeInset";

import { ICON_SIZE } from "@/components/ui/iconSize";
/** The strip's tint: a calm end, a dropped link, or a failure. */
export type DisconnectStripTone = "neutral" | "warning" | "error";

interface DisconnectStripProps {
  /** The notice variant, as `data-variant` (`disconnected`, `failed`, `session-lost`). */
  variant: string;
  /** Why the session ended, as `data-cause`, when known. */
  cause?: string;
  tone: DisconnectStripTone;
  /** Dismisses the strip into view mode. */
  onDismiss: () => void;
  /** Accessible name of the dismiss control. */
  dismissLabel?: string;
  /** The strip body (a `ContentOverlay`, laid out as a row by the strip's CSS). */
  children: ReactNode;
}

/**
 * The session-end strip (#5908): a full-width notice pinned to the top of the
 * terminal slot. It publishes its height as the slot's top-notice inset, so the
 * terminal is pushed down below it (no output line is covered) and the search
 * bar opens under it (#5823). Its body and dismiss control sit together, so the
 * "x" belongs to the notice and says what it does in a tooltip (#5619).
 */
export function DisconnectStrip({
  variant,
  cause,
  tone,
  onDismiss,
  dismissLabel = "Dismiss and view scrollback",
  children,
}: DisconnectStripProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  useTopNoticeInset(stripRef);
  return (
    <div
      ref={stripRef}
      className={`terminal-disconnect-strip terminal-disconnect-strip--${tone}`}
      // The root id is shared with the reconnect strip so the system-test
      // harness finds "the disconnect notice" for every variant.
      data-testid="terminal-disconnect-overlay"
      data-variant={variant}
      data-cause={cause}
      // A toast keep-clear zone (#5823): its actions stay uncovered when the
      // pane's top edge sits in the toast stack's corner.
      {...TOAST_AVOID_PROPS}
    >
      {children}
      <Tooltip content="Dismiss" side="bottom">
        <button
          type="button"
          className="terminal-disconnect-overlay__dismiss terminal-disconnect-strip__dismiss"
          onClick={onDismiss}
          aria-label={dismissLabel}
          data-testid="terminal-disconnect-dismiss-btn"
        >
          <X size={ICON_SIZE.sm} />
        </button>
      </Tooltip>
    </div>
  );
}

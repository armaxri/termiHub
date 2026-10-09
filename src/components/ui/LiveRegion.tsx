import React, { useEffect, useState } from "react";
import "./ui.css";

/** How urgently assistive tech should speak a {@link LiveRegion}'s message. */
export type LiveRegionPoliteness = "polite" | "assertive";

/** Props for the {@link LiveRegion} primitive. */
export interface LiveRegionProps {
  /** The plain-text message to announce. Re-announced only when it changes. */
  message: string;
  /**
   * `polite` (default) renders a `status` region spoken at the next pause;
   * `assertive` renders an `alert` region that interrupts — reserve it for
   * failures the user must act on.
   */
  politeness?: LiveRegionPoliteness;
  /** Test hook forwarded to the region element. */
  "data-testid"?: string;
}

/**
 * A visually-hidden ARIA live region (#4331). Screen readers only announce a
 * live region's *changes*, and many ignore a region that is inserted together
 * with its text, so the region mounts empty and the message is written into it
 * in a follow-up commit. Re-renders with the same message leave the DOM
 * untouched, so an overlay that re-renders (a ticking timer, a store update)
 * never repeats its announcement.
 */
export function LiveRegion({
  message,
  politeness = "polite",
  "data-testid": dataTestId,
}: LiveRegionProps): React.ReactElement {
  const [spoken, setSpoken] = useState("");
  useEffect(() => {
    setSpoken(message);
  }, [message]);

  return (
    <div
      className="ui-visually-hidden"
      role={politeness === "assertive" ? "alert" : "status"}
      aria-live={politeness}
      aria-atomic="true"
      data-testid={dataTestId}
    >
      {spoken}
    </div>
  );
}

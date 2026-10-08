import React from "react";
import { Tooltip } from "./Tooltip";
import "./ui.css";

/** Props for the shared {@link Chip} primitive. */
export interface ChipProps {
  /** The chip's text. */
  label: string;
  /** Optional leading icon (a 12px lucide icon). */
  icon?: React.ReactNode;
  /**
   * Render the chip as something that is *not* allowed — muted and struck
   * through (e.g. a plugin access summary's "Run programs"). The state is also
   * announced: the accessible name gains "(not allowed)".
   */
  denied?: boolean;
  /** Hover/focus help (e.g. the exact rule behind an access chip). */
  tooltip?: React.ReactNode;
  /** Test hook forwarded to the chip element. */
  "data-testid"?: string;
}

/**
 * A small, read-only label pill: an icon plus a short text, optionally struck
 * through for something that is not allowed. Used for summaries such as a
 * native plugin's access chips (#4188). Focusable only when it carries a
 * tooltip, so keyboard users can reach the help text.
 */
export function Chip({
  label,
  icon,
  denied = false,
  tooltip,
  "data-testid": testId,
}: ChipProps): React.ReactElement {
  const chip = (
    <span
      className={`ui-chip${denied ? " ui-chip--denied" : ""}`}
      aria-label={denied ? `${label} (not allowed)` : undefined}
      tabIndex={tooltip ? 0 : undefined}
      data-testid={testId}
    >
      {icon && (
        <span className="ui-chip__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="ui-chip__label">{label}</span>
    </span>
  );
  return tooltip ? (
    <Tooltip content={tooltip} side="bottom">
      {chip}
    </Tooltip>
  ) : (
    chip
  );
}

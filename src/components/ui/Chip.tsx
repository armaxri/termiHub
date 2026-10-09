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
  /**
   * Makes the chip a toggle button (`aria-pressed`) for multi-select choices
   * such as workflow triggers. Called with the next pressed state on click.
   * Without it the chip is a read-only label.
   */
  onPressedChange?: (pressed: boolean) => void;
  /** Pressed state of a toggle chip (only used with `onPressedChange`). */
  pressed?: boolean;
  /** Test hook forwarded to the chip element. */
  "data-testid"?: string;
}

/**
 * A small label pill: an icon plus a short text, optionally struck
 * through for something that is not allowed. Used for summaries such as a
 * native plugin's access chips (#4188). Focusable only when it carries a
 * tooltip, so keyboard users can reach the help text.
 *
 * With `onPressedChange` it becomes a toggle chip: a real `<button>` with
 * `aria-pressed`, styled like the shared radio-card selection (accent border +
 * tint) when pressed (UI2-006).
 */
export function Chip({
  label,
  icon,
  denied = false,
  tooltip,
  onPressedChange,
  pressed = false,
  "data-testid": testId,
}: ChipProps): React.ReactElement {
  const content = (
    <>
      {icon && (
        <span className="ui-chip__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="ui-chip__label">{label}</span>
    </>
  );
  if (onPressedChange) {
    return (
      <button
        type="button"
        className={`ui-chip ui-chip--toggle${pressed ? " ui-chip--pressed" : ""}`}
        aria-pressed={pressed}
        onClick={() => onPressedChange(!pressed)}
        data-testid={testId}
      >
        {content}
      </button>
    );
  }
  const chip = (
    <span
      className={`ui-chip${denied ? " ui-chip--denied" : ""}`}
      aria-label={denied ? `${label} (not allowed)` : undefined}
      tabIndex={tooltip ? 0 : undefined}
      data-testid={testId}
    >
      {content}
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

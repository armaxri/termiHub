import type { CSSProperties, ReactNode } from "react";
import "./SettingsNumberFrame.css";

export interface SettingsNumberFrameProps {
  /** Width of the input in characters (see `settingsNumberChars`). */
  chars: number;
  /** Optional unit shown after the input, e.g. "px" or "lines". */
  unit?: string;
  /** `id` of the unit text, so the input can name it in `aria-describedby`. */
  unitId?: string;
  /** Prefix of the `-unit` test id. */
  "data-testid"?: string;
  /** The numeric input (styled by the `settings-number__input` class). */
  children: ReactNode;
}

/**
 * Lays out a compact numeric settings input (#5843): the input sized to its
 * value range instead of the full column, followed by a muted unit label.
 * Shared by {@link DefaultNumberInput} and {@link SettingsNumberInput}, so
 * every numeric setting has the same width rule and the same unit styling.
 */
export function SettingsNumberFrame({
  chars,
  unit,
  unitId,
  "data-testid": testId,
  children,
}: SettingsNumberFrameProps) {
  const style = { "--settings-number-chars": chars } as CSSProperties;
  return (
    <span className="settings-number" style={style}>
      {children}
      {unit && (
        <span
          id={unitId}
          className="settings-number__unit"
          data-testid={testId ? `${testId}-unit` : undefined}
        >
          {unit}
        </span>
      )}
    </span>
  );
}

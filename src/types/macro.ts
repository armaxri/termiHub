/**
 * A single recorded step of a macro: one chunk of terminal input plus the delay
 * that precedes it during playback. `data` holds the raw input as either UTF-8
 * text or a base64-encoded byte string.
 */
export interface MacroStep {
  /** The recorded input for this step (UTF-8 text or base64-encoded bytes). */
  data: string;
  /** Delay in milliseconds to wait before this step is played back. */
  delayMs: number;
}

/** A named, stored sequence of recorded terminal input. */
export interface Macro {
  /** Unique macro identifier. */
  id: string;
  /** User-friendly name for this macro. */
  name: string;
  /** Optional free-text description. */
  description?: string;
  /** Tags for grouping/filtering in the manager UI. */
  tags: string[];
  /** The ordered steps that make up this macro. */
  steps: MacroStep[];
  /** RFC 3339 timestamp of when the macro was first created. */
  createdAt: string;
  /** RFC 3339 timestamp of the macro's last update. */
  updatedAt: string;
}

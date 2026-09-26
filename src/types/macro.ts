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

/**
 * The terminal state a macro playback ended in. Mirrors the playback service's
 * `MacroPlaybackStatus` and the Rust `MacroRunStatus` enum.
 */
export type MacroRunStatus = "completed" | "cancelled" | "error";

/** What launched a macro playback. Mirrors the Rust `MacroRunOrigin` enum. */
export type MacroRunOrigin = "manual" | "palette" | "workflow-step" | "scheduled";

/**
 * A persisted, **metadata-only** record of a finished macro playback (#3543).
 * Mirrors the Rust `MacroRun` in `src-tauri/src/macros/history.rs` over the wire
 * (camelCase fields, string-valued enums). The macro's recorded input is
 * deliberately **never** stored — only the outcome, timing, targets and origin.
 */
export interface MacroRun {
  /** Unique identifier for this run record. */
  id: string;
  /** The id of the macro that was played. */
  macroId: string;
  /** The macro's name at run time (survives a later rename/deletion). */
  macroName: string;
  /** RFC 3339 timestamp of when the playback started. */
  startedAt: string;
  /** RFC 3339 timestamp of when the playback ended. */
  endedAt: string;
  /** The terminal state the playback ended in. */
  status: MacroRunStatus;
  /** Steps injected before the playback ended. */
  stepsPlayed: number;
  /** Total number of steps in the macro. */
  totalSteps: number;
  /** Number of terminals the playback was started on. */
  targetCount: number;
  /** Display labels (tab titles) of the targets; the backend keeps at most 10. */
  targetLabels?: string[];
  /** What launched the playback. */
  origin: MacroRunOrigin;
  /** For a cancelled / errored playback: a human-readable reason. */
  error?: string;
}

/**
 * Macro DTOs, generated from their Rust source of truth
 * (`src-tauri/src/macros/{config,history}.rs`) via ts-rs (audit DUP-030, #3088).
 */

/**
 * A single recorded step of a macro: one chunk of terminal input (UTF-8 text or
 * a base64-encoded byte string) plus the delay that precedes it on playback.
 */
export type { MacroStep } from "./generated/MacroStep";

/** A named, stored sequence of recorded terminal input. */
export type { Macro } from "./generated/Macro";

/**
 * The terminal state a macro playback ended in. Mirrors the playback service's
 * `MacroPlaybackStatus`.
 */
export type { MacroRunStatus } from "./generated/MacroRunStatus";

/** What launched a macro playback. */
export type { MacroRunOrigin } from "./generated/MacroRunOrigin";

/**
 * A persisted, **metadata-only** record of a finished macro playback (#3543).
 * The macro's recorded input is deliberately **never** stored — only the
 * outcome, timing, targets and origin.
 */
export type { MacroRun } from "./generated/MacroRun";

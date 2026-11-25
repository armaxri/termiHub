/**
 * Typed keys as the run path takes them, and as older builds stored them:
 * generated from `src-tauri/src/macros/config.rs` via ts-rs (audit DUP-030, #3088).
 */

/**
 * A single recorded step of a macro: one chunk of terminal input (UTF-8 text or
 * a base64-encoded byte string) plus the delay that precedes it on playback.
 */
export type { MacroStep } from "./generated/MacroStep";

/** A named, stored sequence of recorded terminal input. */
export type { Macro } from "./generated/Macro";

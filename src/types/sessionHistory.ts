/**
 * A single recorded session in the browsable history, generated from the Rust
 * `SessionHistoryEntry` (`src-tauri/src/session_history/config.rs`) via ts-rs
 * (audit DUP-030, #3088). Passwords and key contents are never stored — only
 * connection metadata carried in `config`.
 */
export type { SessionHistoryEntry } from "./generated/SessionHistoryEntry";

/**
 * A directory bookmarked in the file browser (PROD-007, #3558), generated from
 * the Rust `FileBookmark` (`src-tauri/src/files/bookmarks.rs`) via ts-rs
 * (audit DUP-030, #3088). `scope` is the connection scope the bookmark belongs
 * to — see `fileBookmarkScope` (`local`, `connection:<id>`, `agent:…`, `host:…`).
 */
export type { FileBookmark } from "./generated/FileBookmark";

/**
 * Bookmarks in scope `from` moved to scope `to` — a saved connection's id
 * changed on a rename or move (#3569). Generated from the Rust `ScopeRekey`.
 */
export type { FileBookmarkScopeRekey } from "./generated/FileBookmarkScopeRekey";

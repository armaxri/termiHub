/**
 * The automatically persisted "last session": the open tab groups and their
 * panel layout captured on every change and restored on the next startup.
 *
 * Generated from the Rust `LastSession` (`src-tauri/src/workspace/last_session.rs`)
 * via ts-rs (audit DUP-030, #3088). It reuses the workspace tab-group format so
 * the workspace capture/restore utilities apply unchanged. `activeWorkspaceId`
 * is stamped by the backend on save (#3517); a value sent from here is ignored.
 */
export type { LastSession } from "./generated/LastSession";

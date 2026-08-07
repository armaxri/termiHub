//! Shadow file-browser view authority — Phase 5 of the stateless-UI migration
//! (#2228, part of #2153 / #2139).
//!
//! Moves the file-browser **UI state** the frontend drives in `appStore.ts` —
//! the two browser panes (**local**, **session**), each with its current
//! directory and listing; which pane is active (`fileBrowserMode`); and the
//! copy/cut clipboard (`fileClipboard`) — into a Rust authority on the projection
//! substrate ([`crate::projection`]). Since the SFTP convergence (#2313 / #2422)
//! SSH browses through the `session` pane, so the legacy standalone `sftp` pane
//! is gone.
//!
//! This is the **browser view**, not the session model: the live session ids,
//! connect status, connected host and transfers stay out of scope. The store owns
//! only which directory each pane shows, its listing, the in-flight/error status
//! of a *directory list*, the active pane, and the clipboard. See [`store`] for
//! the scope boundary.
//!
//! # Client-scoped region — Open Design Decision #4 / #6
//!
//! An open file browser is a property of the *viewing client's* pane, not shared
//! infrastructure: the underlying filesystem / SFTP backend is shared, but the
//! browser's cwd, listing, active pane and clipboard belong to the one client
//! looking at it. Like the client-scoped `layout` ([`crate::layout::projection`]),
//! `broadcast` ([`crate::broadcast_projection`]) and `workflow-run`
//! ([`crate::workflow_projection`]) regions — and unlike the shared
//! `session-lifecycle` region — the region is **client-scoped**
//! (`file-browser@<clientId>`).
//!
//! # Shadow only (#2228)
//!
//! Landed as a pure shadow foundation: managed authoritative state that serves
//! the `fileBrowser.*` intents, but nothing in the live UI subscribes to or
//! dispatches them yet — `appStore` stays authoritative and nothing user-facing
//! changes. Later steps cut rendering (the panels read the projected region),
//! then the mutations (browser actions dispatch `fileBrowser.*`), then remove the
//! `appStore` reducers, keeping them as the parity-safe fallback until then.

pub mod projection;
pub mod store;

pub use store::FileBrowserStore;

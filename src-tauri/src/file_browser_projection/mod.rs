//! File-browser view authority — Phase 5 of the stateless-UI migration
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
//! # Authoritative — drives the live UI (#2228)
//!
//! The stateless-UI inversion is complete (#2283): this store is authoritative.
//! The browser panels render from the projected region and browser actions
//! dispatch `fileBrowser.*` intents; the former `appStore` file-browser reducers
//! were removed.

pub mod projection;
pub mod store;

pub use store::FileBrowserStore;

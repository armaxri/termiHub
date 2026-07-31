//! Shadow transfer-queue authority — Phase 5 of the stateless-UI migration
//! (#2229, part of #2153 / #2139).
//!
//! Moves the SFTP/FTP transfer-queue UI state the frontend drives in `appStore`
//! (`transferQueue: Record<transferId, TransferEntry>` + the panel-minimized
//! flag) into a Rust authority on the projection substrate
//! ([`crate::projection`]). The store models the per-transfer queue-row lifecycle
//! — `queued → active → completed | failed | cancelled` (plus `paused`), with
//! byte progress, derived percent/throughput, error message and retry
//! attempt/max-attempt counters — mirroring the frontend `TransferEntry` and the
//! `transferEntryFrom*` folds one-to-one (`src/types/transfer.ts`).
//!
//! This is the **queue-panel view**, not the backend transfer engine: the actual
//! `sftp_download` / `sftp_upload` byte-pump (`src-tauri/src/files/transfer`) and
//! the per-window ownership scoping of a transfer (#1951 / #1964) stay out of
//! scope. The store owns only which transfers the queue shows and each row's
//! derived render state.
//!
//! # Shared region — Open Design Decision #4 / #6
//!
//! A transfer runs backend-side and its progress/state is a property of the
//! transfer, not of a viewing client: two clients watching the same queue see the
//! same bytes, percent and outcome (like SSH tunnels,
//! [`crate::tunnel::projection`], session-lifecycle,
//! [`crate::session_projection`], and system-monitors,
//! [`crate::system_monitor_projection`]). The region is therefore a single
//! **shared** `transfers` region. The per-window choice of *which* transfers a
//! given window renders (the #1951 / #1964 ownership scoping) is presentation and
//! stays a frontend concern under partial projection — the same boundary the
//! system-monitor shadow drew for the status-bar active tab.
//!
//! # Shadow only (#2229)
//!
//! Landed as a pure shadow foundation: managed authoritative state that serves
//! the `transfer.*` intents, but nothing in the live UI subscribes to or
//! dispatches them yet — `appStore` stays authoritative and nothing user-facing
//! changes. Later steps cut rendering (the Transfer Queue panel + Open
//! Connections read the projected `transfers` region), then the mutations, then
//! remove the `appStore` reducers, keeping them as the parity-safe fallback until
//! then.

pub mod projection;
pub mod store;

pub use store::TransferStore;

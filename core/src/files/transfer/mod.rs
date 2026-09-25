//! Backend-agnostic, pure file-transfer machinery (issue #1336; audit finding
//! DUP-026).
//!
//! This module holds the *brains* of the transfer queue — the pieces that carry
//! no I/O, no async, and no dependency on the desktop app (Tauri, `AppHandle`,
//! event emission, or on-disk persistence). Keeping them here lets both the
//! desktop backend and the remote agent (agent-hosted transfers, #3242) reuse
//! one authoritative implementation instead of forking it:
//!
//! - [`state`] — the pure `Queued/Active/Paused/Completed/Failed/Cancelled`
//!   state machine (every transition, valid and invalid, unit-tested).
//! - [`scheduler`] — pure per-session FIFO slot accounting (`max_concurrent`).
//! - [`retry`] — pure exponential backoff schedule, `REST` resume-offset math,
//!   and a deterministic throughput/ETA meter.
//! - [`progress`] — the backend-agnostic progress model: `TransferDirection`,
//!   `TransferPhase`, the `transfer-progress` payload (`TransferProgress`), the
//!   injected [`progress::ProgressSink`] callback, and the shared copy-loop
//!   tuning constants (DUP-026).
//! - [`registry`] — the in-memory registry of in-flight transfers
//!   (`TransferHandle`/`TransferRegistry`/`TransferSnapshot`): the queue /
//!   concurrency / pause / resume / retry control state (DUP-026).
//!
//! The desktop side (`src-tauri`) keeps its command handlers, Tauri event
//! emission, projection wiring, and durable persistence, injecting those
//! side-effects around this pure core. The chunked-copy byte primitive lives in
//! the sibling [`crate::files::copy`] module (DUP-025).

pub mod progress;
pub mod registry;
pub mod retry;
pub mod scheduler;
pub mod state;

// The transport-specific transfer executors (DUP-026 slice 2b). Each drives the
// pure queue machinery above around one backend's streaming primitive, so both
// the desktop backend and the remote agent reuse one implementation. Gated on
// the backend feature they depend on: `ftp` (`crate::backends::ftp`) and `ssh`
// (`crate::backends::ssh`). The public executors return `()` — no error escapes.
#[cfg(feature = "ftp")]
pub mod ftp;
#[cfg(feature = "ssh")]
pub mod sftp;

pub use progress::{
    is_queue_teardown, ProgressSink, TransferDirection, TransferPhase, TransferProgress,
    CHUNK_SIZE, PROGRESS_THROTTLE, QUEUE_TEARDOWN,
};
pub use registry::{TransferHandle, TransferRegistry, TransferSnapshot};
pub use retry::{backoff_delay, resume_offset, ThroughputMeter, BASE_BACKOFF};
pub use scheduler::{Admission, SessionScheduler, DEFAULT_MAX_CONCURRENT};
pub use state::{InvalidTransition, TransferEvent, TransferState, TransferStateTag, MAX_RETRIES};

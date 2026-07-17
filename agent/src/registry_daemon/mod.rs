//! The host-wide registry daemon: a new daemon **role** on the existing daemon
//! substrate (ADR-11 in `docs/architecture.md`).
//!
//! The session daemons are shared across **time** — a restarted worker
//! re-attaches to one and replays its ring buffer — but never across
//! **workers**: their endpoints are per-session (`session-{id}.sock`), a second
//! attach *evicts* the first, and a desktop holding no sessions has no daemon at
//! all. So they cannot answer "who else is attached to this host?".
//!
//! The registry daemon can. It is one process per user per host that every
//! worker registers its client with, keyed to `initialize` rather than to any
//! session — which is what makes a **session-less desktop** visible and
//! reachable, the case an agent binary swap would otherwise kill without
//! warning.
//!
//! It is a new *role*, not a new *mechanism*: [`process`] listens on
//! [`crate::daemon::transport::DaemonListener`], speaks
//! [`crate::daemon::protocol`]'s framing, lives in the same per-user
//! current-user-only socket dir, and is spawned through the same detached-spawn
//! path ([`crate::daemon::spawn`]) as the session daemons. That reuse is what
//! carries over the three properties the role must have: **no new network
//! socket** (unix socket / windows named pipe, current-user-only), **survives an
//! agent binary swap** (detached), and **all three platforms** (inherited from
//! `termihub_core::ipc`).
//!
//! - [`protocol`] — the role's frame vocabulary and record types
//! - [`process`] — the daemon itself (`termihub-agent --registry-daemon`)
//! - [`client`] — the worker-side handle, which treats the registry as optional

pub mod client;
pub mod process;
pub mod protocol;

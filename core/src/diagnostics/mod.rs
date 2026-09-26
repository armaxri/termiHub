//! Local-only crash diagnosability (OBS-010).
//!
//! termiHub never phones home. When something goes wrong, the evidence stays on
//! the user's machine: a bounded directory of redacted crash reports, plus the
//! existing rotating log file. Nothing here opens a socket — the user decides
//! whether (and where) to export a diagnostics bundle.
//!
//! - [`redact`] — the conservative redaction pass every crash report and every
//!   exported log goes through (credentials, keys, tokens, hostnames, IPs,
//!   usernames, home-directory paths).
//! - [`crash_report`] — writing, listing, bounding (count + age), and the
//!   "notify once" bookkeeping for crash reports. Shared by the desktop app and
//!   the agent, which each install their own panic hook on top of it.

pub mod crash_report;
pub mod redact;

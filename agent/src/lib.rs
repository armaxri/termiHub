//! Library surface of the termiHub remote agent.
//!
//! The agent is primarily a binary (`src/main.rs`), but a small, dependency-light
//! slice of it is exposed here as a library so other workspace crates can link
//! against the **authoritative** JSON-RPC wire types.
//!
//! Concretely, the desktop side (`src-tauri`) hand-builds the `connection.files.*`
//! request params (see `RemoteFileBrowserProxy`) with no compile-time link to the
//! agent's parameter structs. Exposing [`protocol`] lets a per-PR contract test in
//! `src-tauri` round-trip those hand-built params through the agent's real structs,
//! catching wire-shape drift without needing a live agent or Docker
//! (audit findings AGT-001, AGT-009, TBE-009).
//!
//! Only self-contained protocol types (serde DTOs over `termihub-core` types) are
//! re-exported here; the rest of the agent remains internal to the binary.

// TOOL-010: enforce the "no `.unwrap()`/`.expect()`/`panic!` in production Rust"
// policy (see `.claude/CLAUDE.md` → Rust). Denied for non-test builds; test code
// (`#[cfg(test)]` modules and `tests/` crates) is exempt via `not(test)`.
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod protocol;

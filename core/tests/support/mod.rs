//! Shared support code for `termihub-core` integration tests that is not tied to
//! the Docker/SSH fixtures in [`crate::common`].
//!
//! It hosts the [`golden`] helper — the cross-language golden-vector runner
//! shared by every `*_golden.rs` suite (#2147) — and, with the `docker`
//! feature, the [`container`] helpers shared by the live container tests (#3888). Each integration test is
//! compiled as its own crate, so a suite that does not use every item here would
//! otherwise warn — allow dead code at the module root.
#![allow(
    dead_code,
    reason = "shared test-support module: each test binary uses a different subset"
)]

#[cfg(feature = "docker")]
pub mod container;
// The fixture resolver and skip-or-fail gate shared by every crate's
// integration tests (#4338); see `core/tests/common` for why it is included by
// path.
#[path = "../../src/test_fixtures.rs"]
pub mod fixture_env;
pub mod golden;

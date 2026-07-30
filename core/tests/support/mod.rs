//! Shared support code for `termihub-core` integration tests that is not tied to
//! the Docker/SSH fixtures in [`crate::common`].
//!
//! Currently this hosts the [`golden`] helper: the cross-language golden-vector
//! runner shared by every `*_golden.rs` suite (#2147). Each integration test is
//! compiled as its own crate, so a suite that does not use every item here would
//! otherwise warn — allow dead code at the module root.
#![allow(dead_code)]

pub mod golden;

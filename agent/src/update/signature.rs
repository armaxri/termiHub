//! Ed25519 signature verification for agent self-updates (AGT-005, #3213).
//!
//! The implementation lives in `termihub_core::agent_update_signature` so the
//! desktop verifies agent binaries with exactly the same code and trusted key
//! set before deploying them (#3330). This module re-exports it under the
//! agent's historical `update::signature` path.

pub use termihub_core::agent_update_signature::{
    signature_sidecar_path, SignaturePolicy, UpdateSignatureError,
};

#[cfg(test)]
pub(crate) use termihub_core::agent_update_signature::test_support;

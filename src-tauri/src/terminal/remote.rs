//! Remote backend for connecting to a termihub-agent over SSH.
//!
//! Implements the `TerminalBackend` trait by exchanging JSON-RPC 2.0
//! messages over an SSH exec channel running `termihub-agent --stdio`.

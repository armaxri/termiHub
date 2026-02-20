//! Session daemon process — manages a single PTY + ring buffer.
//!
//! Invoked as `termihub-agent --daemon <session-id>` by the agent.
//! Communicates with the agent via a Unix domain socket using the
//! length-prefixed binary frame protocol defined in `protocol.rs`.

// Placeholder — implemented in commit 3.

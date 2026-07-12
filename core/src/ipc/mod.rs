//! Shared local-IPC transport and NDJSON framing (#1386).
//!
//! Consolidates the cross-platform local-socket / named-pipe transport plus
//! newline-delimited-JSON framing that was previously duplicated between the
//! desktop spawn IPC (`src-tauri/src/spawn`) and the agent daemon/JSON-RPC
//! transports.
//!
//! - [`local_socket`] — a protocol-agnostic Unix-domain-socket / named-pipe
//!   transport: [`LocalSocketListener`] (bind/accept) plus a fail-fast
//!   [`connect`]. It moves opaque byte streams and imposes no framing.
//! - [`ndjson`] — newline-delimited-JSON line read/write helpers layered on top
//!   of any async reader/writer.

pub mod local_socket;
pub mod ndjson;

pub use local_socket::{connect, BoxedReader, BoxedWriter, LocalSocketListener};
pub use ndjson::{read_line, write_line};

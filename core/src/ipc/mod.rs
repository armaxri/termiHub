//! Shared local-IPC transport and NDJSON framing (#1386).
//!
//! Consolidates the cross-platform local-socket / named-pipe transport plus
//! newline-delimited-JSON framing that was previously duplicated between the
//! desktop spawn IPC (`src-tauri/src/spawn`) and the agent daemon/JSON-RPC
//! transports.
//!
//! - [`local_socket`] — a protocol-agnostic Unix-domain-socket / named-pipe
//!   transport: [`LocalSocketListener`] (bind/accept) plus a fail-fast
//!   [`connect`]. It moves opaque byte streams and imposes no framing. Optional
//!   policies layer on additively: [`connect_with_retry`] for a bounded retry
//!   loop, and [`ListenerOptions`] (a [`ListenerSecurity`] hardening policy plus
//!   a [`StaleReclaim`] policy) for security-hardened, self-reclaiming
//!   listeners such as the agent session daemon.
//! - [`ndjson`] — newline-delimited-JSON line read/write helpers layered on top
//!   of any async reader/writer.

pub mod local_socket;
pub mod ndjson;

pub use local_socket::{
    connect, connect_with_retry, BoxedReader, BoxedWriter, ListenerOptions, ListenerSecurity,
    LocalSocketListener, StaleReclaim,
};
pub use ndjson::{read_line, write_line};

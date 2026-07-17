//! Frame vocabulary for the host-wide registry daemon (ADR-11).
//!
//! This is a **new daemon role on the existing substrate**, not a new
//! mechanism: the wire encoding is exactly [`crate::daemon::protocol`]'s
//! `[type: 1][length: 4 BE][payload]` framing, read and written with the same
//! [`read_frame_async`](crate::daemon::protocol::read_frame_async) /
//! [`write_frame_async`](crate::daemon::protocol::write_frame_async). Only the
//! message *types* and their payload meanings are new.
//!
//! The session-daemon vocabulary is a byte stream of PTY traffic, so its
//! payloads are raw bytes. The registry's payloads are **structured records**
//! (who is connected; what to tell everyone), so they are JSON — the same shape
//! the `agent.list_connections` RPC and the JSON-RPC notifications already
//! serialize. The volume is a handful of frames per client per session, not a
//! keystroke stream, so the encoding cost that motivated the binary session
//! protocol does not apply here.
//!
//! Type numbers deliberately do not overlap the session daemon's (`0x01..0x05`,
//! `0x81..0x85`). The two roles listen on different endpoints and can never
//! exchange frames, so a collision would be harmless — but a distinct range
//! means a frame dump is never ambiguous about which role produced it.
//!
//! ```text
//!  worker ──REGISTER (ClientRecord)──► registry ──ACK──► worker
//!  worker ──LIST────────────────────► registry ──CLIENTS (Vec<ClientRecord>)──► worker
//!  worker ──BROADCAST (Envelope)────► registry ──EVENT (Envelope)──► every *other* worker
//!  worker ──DEREGISTER──────────────► registry
//!  worker ──(disconnect / crash)────► registry drops the record implicitly
//! ```

use serde::{Deserialize, Serialize};

// ── Worker → Registry ───────────────────────────────────────────────

/// Worker → Registry: announce this worker's client (payload: JSON
/// [`ClientRecord`]). Re-sent verbatim after a reconnect, which is what makes a
/// registry restart transparent to an already-running worker.
pub const MSG_REGISTER: u8 = 0x10;
/// Worker → Registry: withdraw this worker's client (empty payload). The
/// connection stays open; used when a client disconnects but the worker lives
/// on.
pub const MSG_DEREGISTER: u8 = 0x11;
/// Worker → Registry: request the current host-wide client set (empty payload).
pub const MSG_LIST: u8 = 0x12;
/// Worker → Registry: fan this notification out to every other worker (payload:
/// JSON [`BroadcastEnvelope`]).
pub const MSG_BROADCAST: u8 = 0x13;

// ── Registry → Worker ───────────────────────────────────────────────

/// Registry → Worker: a [`MSG_REGISTER`] was recorded (empty payload).
pub const MSG_ACK: u8 = 0x90;
/// Registry → Worker: the host-wide client set (payload: JSON
/// `Vec<ClientRecord>`), answering a [`MSG_LIST`].
pub const MSG_CLIENTS: u8 = 0x91;
/// Registry → Worker: another worker broadcast this (payload: JSON
/// [`BroadcastEnvelope`]).
pub const MSG_EVENT: u8 = 0x92;

// ── Payloads ────────────────────────────────────────────────────────

/// One client, as seen host-wide.
///
/// Field-for-field the `ConnectionInfo` the `agent.list_connections` RPC returns
/// (`connected_since` already RFC 3339), so a registry snapshot maps into an RPC
/// response without a second representation. `pid` is the *worker* process's id
/// — not part of the RPC shape, but the thing that makes a record attributable
/// to an OS process when debugging a host with several desktops attached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientRecord {
    /// Agent-assigned unique id for the client connection (from `initialize`).
    pub client_id: String,
    /// Client name reported in `initialize` (e.g. `"termihub-desktop"`).
    pub client: String,
    /// Client version reported in `initialize`.
    pub client_version: String,
    /// RFC 3339 timestamp of when the client completed `initialize`.
    pub connected_since: String,
    /// OS process id of the agent worker serving this client.
    pub pid: u32,
}

/// A notification one worker wants every other worker's client to receive.
///
/// Carries a JSON-RPC notification's `method` and `params` verbatim so a
/// receiving worker can reconstruct it without interpreting it, plus the
/// originating `client_id` — the registry uses it to avoid echoing a broadcast
/// back to its sender, and a receiver can use it to attribute the event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BroadcastEnvelope {
    /// `client_id` of the client whose worker originated this broadcast.
    pub origin_client_id: String,
    /// JSON-RPC notification method name.
    pub method: String,
    /// JSON-RPC notification params.
    pub params: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::protocol as frames;
    use serde_json::json;

    fn sample_record() -> ClientRecord {
        ClientRecord {
            client_id: "abc".into(),
            client: "termihub-desktop".into(),
            client_version: "1.2.3".into(),
            connected_since: "2026-07-17T10:00:00+00:00".into(),
            pid: 4242,
        }
    }

    #[test]
    fn client_record_round_trips_as_json() {
        let record = sample_record();
        let bytes = serde_json::to_vec(&record).expect("serialize");
        let back: ClientRecord = serde_json::from_slice(&bytes).expect("deserialize");
        assert_eq!(back, record);
    }

    #[test]
    fn broadcast_envelope_round_trips_as_json() {
        let envelope = BroadcastEnvelope {
            origin_client_id: "abc".into(),
            method: "agent.update_pending".into(),
            params: json!({"version": "2.0.0"}),
        };
        let bytes = serde_json::to_vec(&envelope).expect("serialize");
        let back: BroadcastEnvelope = serde_json::from_slice(&bytes).expect("deserialize");
        assert_eq!(back, envelope);
    }

    /// The registry's payloads must survive the *session daemon's* framing
    /// untouched — that reuse is the whole premise of "a new role on the
    /// existing substrate" (ADR-11).
    #[tokio::test]
    async fn register_payload_survives_the_session_daemon_framing() {
        let record = sample_record();
        let mut buf: Vec<u8> = Vec::new();
        frames::write_frame_async(
            &mut buf,
            MSG_REGISTER,
            &serde_json::to_vec(&record).unwrap(),
        )
        .await
        .expect("write frame");

        let mut cursor = std::io::Cursor::new(buf);
        let frame = frames::read_frame_async(&mut cursor)
            .await
            .expect("read frame")
            .expect("frame present");

        assert_eq!(frame.msg_type, MSG_REGISTER);
        let back: ClientRecord = serde_json::from_slice(&frame.payload).expect("decode payload");
        assert_eq!(back, record);
    }

    /// A frame dump must never be ambiguous about which daemon role wrote it.
    #[test]
    fn registry_types_do_not_collide_with_session_daemon_types() {
        use crate::daemon::protocol as session;
        let registry = [
            MSG_REGISTER,
            MSG_DEREGISTER,
            MSG_LIST,
            MSG_BROADCAST,
            MSG_ACK,
            MSG_CLIENTS,
            MSG_EVENT,
        ];
        let session = [
            session::MSG_INPUT,
            session::MSG_RESIZE,
            session::MSG_DETACH,
            session::MSG_KILL,
            session::MSG_QUERY_BUFFER,
            session::MSG_OUTPUT,
            session::MSG_BUFFER_REPLAY,
            session::MSG_EXITED,
            session::MSG_ERROR,
            session::MSG_READY,
        ];
        for r in registry {
            assert!(
                !session.contains(&r),
                "type 0x{r:02x} is used by both roles"
            );
        }
    }
}

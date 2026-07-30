//! Wire envelopes for the stateless-UI projection substrate (#2149).
//!
//! These `serde` structs are the twin of the TypeScript envelopes in
//! `src/services/transport/types.ts`. They are transport-neutral: identical
//! whether they ride Tauri IPC (desktop) or JSON-RPC over WebSocket
//! (remote-client mode). See the design concept
//! `docs/concepts/future/stateless-ui-projection-substrate.html`.
//!
//! The substrate carries two new generic channels:
//!
//! * **channel 1 — `dispatch(intent)`** (UI → backend): one serialisable
//!   [`Intent`], answered by an [`IntentAck`] receipt.
//! * **channel 2 — `subscribe(region)`** (backend → UI): an initial
//!   [`SnapshotFrame`] then an ordered stream of [`DiffFrame`]s.
//!
//! The terminal byte stream (`terminal-output`) is channel 3 and is wholly
//! independent of this module.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A user intent dispatched by a client (channel 1, UI → backend).
///
/// The result of an intent is never returned inline; it is always a projection
/// diff on the affected region(s). The [`IntentAck`] is only a receipt.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Intent {
    /// Client-generated ULID; correlates the ack (and any optimistic echo).
    pub intent_id: String,
    /// Dotted `<domain>.<action>`, e.g. `"tunnel.start"`, `"layout.moveTab"`.
    pub kind: String,
    /// Kind-specific, serialisable payload; validated backend-side.
    pub payload: Value,
    /// Which attached client dispatched it (fan-out / audit identity).
    pub client_id: String,
}

/// Whether the dispatcher accepted or rejected an [`Intent`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IntentStatus {
    Accepted,
    Rejected,
}

/// Error detail attached to a rejected [`IntentAck`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IntentErrorInfo {
    pub code: String,
    pub message: String,
}

/// A region advanced by an intent, so a client can await the confirming diff
/// before clearing an optimistic echo.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProducedRegion {
    pub region: String,
    pub version: u64,
}

/// Receipt for a dispatched [`Intent`] (channel 1 reply).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IntentAck {
    /// Echoes the request's `intentId`.
    pub intent_id: String,
    pub status: IntentStatus,
    /// Present iff `status == rejected`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<IntentErrorInfo>,
    /// Regions this intent advanced. Empty for no-op / query intents.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub produced: Option<Vec<ProducedRegion>>,
}

impl IntentAck {
    /// Build an `accepted` ack listing the regions the intent advanced.
    pub fn accepted(intent_id: impl Into<String>, produced: Vec<ProducedRegion>) -> Self {
        Self {
            intent_id: intent_id.into(),
            status: IntentStatus::Accepted,
            error: None,
            produced: Some(produced),
        }
    }

    /// Build a `rejected` ack carrying an error code and message.
    pub fn rejected(
        intent_id: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            intent_id: intent_id.into(),
            status: IntentStatus::Rejected,
            error: Some(IntentErrorInfo {
                code: code.into(),
                message: message.into(),
            }),
            produced: None,
        }
    }
}

/// A projection frame pushed to a subscriber (channel 2, backend → UI).
///
/// Internally tagged by `kind`, matching the TypeScript discriminated union
/// `{ kind: "snapshot" | "diff", ... }`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ProjectionFrame {
    Snapshot(SnapshotFrame),
    Diff(DiffFrame),
}

impl ProjectionFrame {
    /// The region this frame belongs to.
    pub fn region(&self) -> &str {
        match self {
            ProjectionFrame::Snapshot(f) => &f.region,
            ProjectionFrame::Diff(f) => &f.region,
        }
    }

    /// The version the cache holds after applying this frame.
    pub fn version(&self) -> u64 {
        match self {
            ProjectionFrame::Snapshot(f) => f.version,
            ProjectionFrame::Diff(f) => f.version,
        }
    }
}

/// The complete, render-ready view model for a region at a baseline version.
///
/// Emitted on attach and on resync only; steady state is [`DiffFrame`]s.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFrame {
    pub region: String,
    /// `u64` monotonic; the cache adopts this as its baseline.
    pub version: u64,
    /// The complete, render-ready view model for the region.
    pub view: Value,
}

/// An ordered mutation of a region's cached view model.
///
/// `baseVersion` MUST equal the cache's current version, else the client
/// detects a gap and calls `resync`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffFrame {
    pub region: String,
    /// MUST equal the cache's current version, else it is a gap.
    pub base_version: u64,
    /// `== base_version + 1`.
    pub version: u64,
    /// Ordered mutations to apply to the cached view model.
    pub ops: Vec<DiffOp>,
}

/// A single diff operation.
///
/// The default shape is an RFC 6902 JSON-Patch subset (`add` / `remove` /
/// `replace`). [`DiffOp::Semantic`] is the per-domain compact-op escape hatch
/// reserved by the design; it is **unused** in Phase 1.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum DiffOp {
    /// RFC 6902 `replace`.
    Replace { path: String, value: Value },
    /// RFC 6902 `add`.
    Add { path: String, value: Value },
    /// RFC 6902 `remove`.
    Remove { path: String },
    /// Escape hatch: a compact per-domain semantic op. Reserved, unused in
    /// Phase 1; has no RFC 6902 mapping and is never emitted by the default
    /// structural differ.
    Semantic { name: String, data: Value },
}

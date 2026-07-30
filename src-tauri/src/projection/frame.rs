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
/// A discriminated union on `kind`, matching the TypeScript
/// `{ kind: "snapshot" | "diff", ... }`. The discriminator lives on each
/// variant's own struct ([`SnapshotFrame::kind`] / [`DiffFrame::kind`]) rather
/// than being synthesised by an internal serde `tag`, so a frame returned
/// **bare** from a command (`projection_subscribe` / `projection_resync` hand
/// back a lone [`SnapshotFrame`]) carries exactly the same `kind` as the same
/// frame wrapped in this enum — no missing tag on the bare form, no doubled tag
/// on the wrapped form (#2170). The enum is therefore `untagged`: it adds
/// nothing to the wire, and the per-variant literal `kind` markers are what let
/// deserialisation tell a snapshot from a diff.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
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

/// The `kind` discriminator of a [`SnapshotFrame`] — always `"snapshot"`.
///
/// A dedicated single-variant enum (rather than a bare `String`) so the field
/// is self-describing and, crucially, so a *diff*'s `kind: "diff"` fails to
/// deserialise into it — that mismatch is what lets the `untagged`
/// [`ProjectionFrame`] discriminate the two frames.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotKind {
    #[default]
    Snapshot,
}

/// The `kind` discriminator of a [`DiffFrame`] — always `"diff"`. See
/// [`SnapshotKind`] for why this is a single-variant enum.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum DiffKind {
    #[default]
    Diff,
}

/// The complete, render-ready view model for a region at a baseline version.
///
/// Emitted on attach and on resync only; steady state is [`DiffFrame`]s.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFrame {
    /// Discriminator (`"snapshot"`); carried on the struct so the bare
    /// subscribe/resync return value tags itself, matching the TS
    /// `SnapshotFrame` type (#2170). `default` keeps a producer that omits it
    /// deserialisable.
    #[serde(default)]
    pub kind: SnapshotKind,
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
    /// Discriminator (`"diff"`); carried on the struct so this frame tags
    /// itself identically whether bare or wrapped in [`ProjectionFrame`]
    /// (#2170). `default` keeps a producer that omits it deserialisable.
    #[serde(default)]
    pub kind: DiffKind,
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

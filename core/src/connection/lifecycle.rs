//! The canonical session-lifecycle vocabulary shared across the workspace
//! (SM-020 slice 0).
//!
//! [`SessionStatus`] is the coarse connect / reconnect / disconnect / error
//! state a session moves through. It originated in the desktop
//! `session_projection` region (#2152, Phase 4 of #2139) and is re-exported from
//! there unchanged; it now lives in `core` — next to the pure, timer-free
//! auto-reconnect engine ([`crate::reconnect_backoff`]) it composes with — so
//! core-level consumers (monitoring, graphical) can share one canonical
//! vocabulary instead of each maintaining a private status enum.
//!
//! # Mapping functions — additive scaffold, not yet wired
//!
//! Each other subsystem currently owns its own status enum
//! ([`MonitorStatus`](crate::monitoring::MonitorStatus),
//! [`GraphicalState`](crate::connection::graphical::GraphicalState), and the
//! desktop-side `AgentConnectionState` / `TunnelStatus`). This module adds total
//! `From<…> for SessionStatus` conversions so later SM-020 slices can migrate
//! those subsystems onto the canonical vocabulary. The conversions are
//! **dead-but-tested** here: nothing in a runtime path calls them yet, and no
//! subsystem's own status handling changes.
//!
//! The two conversions whose source enum lives in `core` are defined here; the
//! `AgentConnectionState` and `TunnelStatus` conversions must live in the
//! desktop crate that defines those enums (dependency direction + orphan rules
//! forbid `core` from naming them).
//!
//! Some source variants have no clean canonical equivalent and are mapped to the
//! closest [`SessionStatus`], flagged inline as **lossy / placeholder** pending
//! the maintainer's vocabulary decision. No new canonical variant is invented —
//! that would be a maintainer fork of the vocabulary, out of scope for this
//! behavior-preserving scaffold.

use serde::{Deserialize, Serialize};

/// Top-level lifecycle status of a single session — the coarse state the UI
/// renders (overlay / spinner / live). The fine-grained auto-reconnect detail
/// (attempt count, backoff delay, waiting-vs-connecting) lives in the composed
/// [`ReconnectState`](crate::reconnect_backoff::ReconnectState), authored by the
/// ported #2144 engine.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    /// An initial connect attempt is in flight (the "Connecting…" overlay).
    Connecting,
    /// A live session.
    Connected,
    /// The session ended and is idle (no retry loop running). `end_reason`
    /// says why; a user disconnect and an unexpected drop both land here.
    Disconnected,
    /// An auto-reconnect loop is active; see the composed `reconnect` detail.
    Reconnecting,
    /// A terminal failure: the initial connect errored, or the reconnect loop
    /// exhausted its attempts. `error` carries the message; the user may
    /// manually reconnect.
    Failed,
    /// A distinct terminal failure (SM-005): the connect was **rejected by
    /// authentication** — wrong password/passphrase or a refused key. Unlike
    /// [`Failed`](Self::Failed) (a transient failure the reconnect loop may have
    /// exhausted after many attempts), an auth rejection is genuinely
    /// **non-retryable**: the same credentials can never succeed, so the loop is
    /// NOT armed and the tab never enters [`Reconnecting`](Self::Reconnecting) or
    /// burns doomed reconnect attempts. The user must fix the credentials and
    /// manually reconnect. `error` carries the message. Serialised as `authFailed`
    /// for the frontend to key on (mirroring how [`SessionLost`](Self::SessionLost)
    /// serialises as `sessionLost`).
    #[serde(rename = "authFailed")]
    AuthFailed,
    /// A distinct terminal state (#2512): a resilient **agent**-hosted tab
    /// re-established its transport on reconnect, but the **live agent session**
    /// it was attached to (its running process, e.g. a compile) could not be
    /// recovered — the agent hard-restarted, the session aged out, or its daemon
    /// died. The desktop deliberately does **not** silently mint a new shell in
    /// its place (maintainer decision); it surfaces this explicit state so the
    /// frontend can render a clear "session lost" notice plus a manual "start new
    /// shell" action. Serialised as `sessionLost` for the frontend to key on.
    #[serde(rename = "sessionLost")]
    SessionLost,
    /// A distinct state (SM-003, maintainer decision 2026-09-26: single-attach):
    /// the session is **alive** but another desktop (or window) took control of
    /// it, so this tab no longer does. Only one client controls a session at a
    /// time; the daemon evicts the previous owner when another attaches with
    /// takeover intent. Terminal **until user action**: it is never left by an
    /// automatic transition (an auto-reconnect would re-take control and
    /// ping-pong ownership between two desktops) — only an explicit **Reclaim**
    /// (which evicts the other side in turn), a fresh user connect, a user
    /// disconnect, or closing the tab. Serialised as `evicted`.
    Evicted,
}

use crate::connection::graphical::GraphicalState;
use crate::monitoring::MonitorStatus;

/// Map a [`MonitorStatus`] onto the canonical [`SessionStatus`] (SM-020 slice 0,
/// additive — not yet wired into any runtime path).
///
/// `Connecting` / `Live` / `Reconnecting` map to their canonical twins; the
/// budget-exhausted `Offline` maps to the terminal [`Failed`](SessionStatus::Failed).
/// Two variants are **lossy / placeholder** pending the maintainer vocab decision:
/// - `Stale` (transport dropped mid-stream, last stats frozen) → `Disconnected`:
///   the link is down, but the canonical vocabulary has no "showing frozen data"
///   state.
/// - `Paused` (user paused collection, transport still open) → `Connected`: the
///   transport is up, but there is no canonical "paused" state.
impl From<MonitorStatus> for SessionStatus {
    fn from(status: MonitorStatus) -> Self {
        match status {
            MonitorStatus::Connecting => SessionStatus::Connecting,
            MonitorStatus::Live => SessionStatus::Connected,
            // Lossy / placeholder: no canonical "frozen last stats" state.
            MonitorStatus::Stale => SessionStatus::Disconnected,
            MonitorStatus::Reconnecting => SessionStatus::Reconnecting,
            MonitorStatus::Offline => SessionStatus::Failed,
            // Lossy / placeholder: no canonical "paused, transport open" state.
            MonitorStatus::Paused => SessionStatus::Connected,
        }
    }
}

/// Map a [`GraphicalState`] onto the canonical [`SessionStatus`] (SM-020 slice 0,
/// additive — not yet wired into any runtime path).
///
/// `Connecting` / `Reconnecting` / `AuthFailed` map to their canonical twins;
/// `ConnectFailed` maps to the canonical terminal [`Failed`](SessionStatus::Failed),
/// and `Disconnected` / `Closed` map to [`Disconnected`](SessionStatus::Disconnected).
/// Several variants are **lossy / placeholder** pending the maintainer vocab
/// decision:
/// - `Authenticating` (transport up, negotiating auth) → `Connecting`: still
///   establishing, but the canonical vocabulary does not distinguish an auth phase.
/// - `Active` and `Resizing` both collapse to `Connected`: the canonical
///   vocabulary has no distinct "resizing" state, so the live paint state and the
///   awaiting-new-resolution state are indistinguishable once mapped.
/// - `ServerClosed` (clean server-side logoff) → `Disconnected`: the canonical
///   vocabulary has no distinct clean-close state, so it is folded with a plain
///   disconnect.
impl From<GraphicalState> for SessionStatus {
    fn from(state: GraphicalState) -> Self {
        match state {
            GraphicalState::Connecting => SessionStatus::Connecting,
            // Lossy / placeholder: no canonical auth-negotiation phase.
            GraphicalState::Authenticating => SessionStatus::Connecting,
            GraphicalState::Active => SessionStatus::Connected,
            // Lossy / placeholder: collapses with `Active` — no canonical "resizing".
            GraphicalState::Resizing => SessionStatus::Connected,
            GraphicalState::Disconnected => SessionStatus::Disconnected,
            GraphicalState::Reconnecting => SessionStatus::Reconnecting,
            // Lossy / placeholder: no canonical clean server-close state.
            GraphicalState::ServerClosed => SessionStatus::Disconnected,
            GraphicalState::AuthFailed => SessionStatus::AuthFailed,
            GraphicalState::ConnectFailed => SessionStatus::Failed,
            GraphicalState::Closed => SessionStatus::Disconnected,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_status_serialises_unchanged() {
        // The wire form must be byte-identical to the pre-move enum: lowercase
        // variant names, with the two explicit renames preserved.
        let cases = [
            (SessionStatus::Connecting, "\"connecting\""),
            (SessionStatus::Connected, "\"connected\""),
            (SessionStatus::Disconnected, "\"disconnected\""),
            (SessionStatus::Reconnecting, "\"reconnecting\""),
            (SessionStatus::Failed, "\"failed\""),
            (SessionStatus::AuthFailed, "\"authFailed\""),
            (SessionStatus::SessionLost, "\"sessionLost\""),
            (SessionStatus::Evicted, "\"evicted\""),
        ];
        for (variant, expected) in cases {
            assert_eq!(serde_json::to_string(&variant).unwrap(), expected);
            let round: SessionStatus = serde_json::from_str(expected).unwrap();
            assert_eq!(round, variant);
        }
    }

    #[test]
    fn monitor_status_maps_totally() {
        // Total: every MonitorStatus variant has a documented canonical target.
        let cases = [
            (MonitorStatus::Connecting, SessionStatus::Connecting),
            (MonitorStatus::Live, SessionStatus::Connected),
            (MonitorStatus::Stale, SessionStatus::Disconnected),
            (MonitorStatus::Reconnecting, SessionStatus::Reconnecting),
            (MonitorStatus::Offline, SessionStatus::Failed),
            (MonitorStatus::Paused, SessionStatus::Connected),
        ];
        for (input, expected) in cases {
            assert_eq!(SessionStatus::from(input), expected);
        }
    }

    #[test]
    fn graphical_state_maps_totally() {
        // Total: every GraphicalState variant has a documented canonical target.
        let cases = [
            (GraphicalState::Connecting, SessionStatus::Connecting),
            (GraphicalState::Authenticating, SessionStatus::Connecting),
            (GraphicalState::Active, SessionStatus::Connected),
            (GraphicalState::Resizing, SessionStatus::Connected),
            (GraphicalState::Disconnected, SessionStatus::Disconnected),
            (GraphicalState::Reconnecting, SessionStatus::Reconnecting),
            (GraphicalState::ServerClosed, SessionStatus::Disconnected),
            (GraphicalState::AuthFailed, SessionStatus::AuthFailed),
            (GraphicalState::ConnectFailed, SessionStatus::Failed),
            (GraphicalState::Closed, SessionStatus::Disconnected),
        ];
        for (input, expected) in cases {
            assert_eq!(SessionStatus::from(input), expected);
        }
    }
}

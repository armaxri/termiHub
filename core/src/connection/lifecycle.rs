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
        ];
        for (variant, expected) in cases {
            assert_eq!(serde_json::to_string(&variant).unwrap(), expected);
            let round: SessionStatus = serde_json::from_str(expected).unwrap();
            assert_eq!(round, variant);
        }
    }
}

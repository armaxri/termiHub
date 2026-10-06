//! Session re-attachment for relaunched agent-hosted transfers (#4114).
//!
//! A queued transfer of an agent-hosted session runs over the agent's ranged
//! slices (`run_ranged_transfer`, #3587). Its record keeps the session's
//! **identity** ([`PersistedAgentTarget`]): the agent id, the agent-side session
//! id and the saved agent definition the session was opened from — never a
//! credential, which stays with the agent. The desktop session id does not
//! survive an app restart, so a relaunch looks for a live agent session by that
//! identity, in this order:
//!
//! 1. **the same agent-side session** on the same agent — the original session,
//!    still live in this run;
//! 2. **a session opened from the same saved definition** on the same agent —
//!    the user reconnected the agent and reopened the connection, under new
//!    desktop and agent-side session ids, onto the same remote file system.
//!
//! A session on any other agent, or one on the same agent for a different (or
//! no) definition, never matches: a partial is never resumed into a different
//! file system. Each match is then asked whether it serves ranged slices (the
//! zero-length probe) before it is used.
//!
//! When no session matches yet — typically after a restart, before the agent
//! is reconnected — the row stays **paused** with
//! [`AGENT_SESSION_UNAVAILABLE`] and waits: once a session opens on that agent
//! for that definition, it resumes by itself (see [`super::relaunch_auto`]), as
//! a direct-session transfer waiting for its connection does. **Resume** re-runs
//! the same resolution at any time; the persisted record is kept either way.
//!
//! The executor then starts from the persisted offset; its resume gate still
//! re-verifies the source fingerprint and the destination before appending.

use std::future::Future;
use std::sync::Arc;

use super::persist::PersistedAgentTarget;
use super::relaunch_credentials::RelaunchBlocked;
use crate::session::manager::SessionManager;
use crate::session::remote_proxy::RemoteFileBrowserProxy;

/// The reason a relaunched agent-hosted transfer stays paused while no
/// matching agent session is live.
pub(crate) const AGENT_SESSION_UNAVAILABLE: &str =
    "Agent session unavailable — reconnect the agent and open the connection to resume";

/// Who serves a live agent-hosted session: ids only, never a secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSessionIdentity {
    /// The agent the session runs on.
    pub agent_id: String,
    /// The agent-side session id.
    pub remote_session_id: String,
    /// The saved agent definition the session was opened from, if any.
    pub definition_id: Option<String>,
}

impl AgentSessionIdentity {
    /// The identity a transfer on this session records.
    pub(crate) fn to_persisted(&self) -> PersistedAgentTarget {
        PersistedAgentTarget {
            agent_id: self.agent_id.clone(),
            remote_session_id: self.remote_session_id.clone(),
            definition_id: self.definition_id.clone(),
        }
    }
}

/// How well the live session `live` matches the persisted identity: `0` for
/// the same agent-side session, `1` for a session of the same saved
/// definition, `None` for anything else — another agent, another definition,
/// or an ad-hoc session that is not the original one.
fn match_rank(persisted: &PersistedAgentTarget, live: &AgentSessionIdentity) -> Option<u8> {
    if persisted.agent_id.is_empty() || live.agent_id != persisted.agent_id {
        return None;
    }
    if !persisted.remote_session_id.is_empty()
        && live.remote_session_id == persisted.remote_session_id
    {
        return Some(0);
    }
    match (&persisted.definition_id, &live.definition_id) {
        (Some(persisted), Some(live)) if !persisted.is_empty() && persisted == live => Some(1),
        _ => None,
    }
}

/// The live sessions a relaunch may use, best match first; sessions whose
/// identity does not match are dropped.
pub(crate) fn rank_candidates<T>(
    persisted: &PersistedAgentTarget,
    live: Vec<(AgentSessionIdentity, T)>,
) -> Vec<T> {
    let mut ranked: Vec<(u8, T)> = live
        .into_iter()
        .filter_map(|(identity, target)| {
            let rank = match_rank(persisted, &identity);
            if rank.is_none() {
                tracing::debug!(
                    persisted_agent = %persisted.agent_id,
                    live_agent = %identity.agent_id,
                    "agent session does not match the transfer's identity; not resuming there"
                );
            }
            rank.map(|rank| (rank, target))
        })
        .collect();
    ranked.sort_by_key(|(rank, _)| *rank);
    ranked.into_iter().map(|(_, target)| target).collect()
}

/// Resolve the session a relaunched agent-hosted transfer runs on from the
/// `live` agent sessions: the best identity match that passes `probe` (the
/// ranged-slices check). No match keeps the row paused
/// ([`RelaunchBlocked::AgentSessionUnavailable`]); matches that all refuse
/// the probe fail it with the probe's reason.
pub(crate) async fn resolve_agent_target<T, F, Fut>(
    persisted: &PersistedAgentTarget,
    live: Vec<(AgentSessionIdentity, T)>,
    probe: F,
) -> Result<T, RelaunchBlocked>
where
    T: Clone,
    F: Fn(T) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let candidates = rank_candidates(persisted, live);
    let mut refused = None;
    for candidate in candidates {
        match probe(candidate.clone()).await {
            Ok(()) => return Ok(candidate),
            Err(e) => refused = Some(e),
        }
    }
    match refused {
        None => Err(RelaunchBlocked::AgentSessionUnavailable),
        Some(e) => Err(RelaunchBlocked::Failed(format!(
            "Cannot resume: the reconnected agent session does not serve ranged \
             file transfers ({e}) — update the agent, then Retry"
        ))),
    }
}

/// Resolve the live agent session a relaunched agent-hosted transfer runs on
/// (see the module docs).
pub(crate) async fn resolve_live_agent_target(
    manager: &SessionManager,
    persisted: &PersistedAgentTarget,
) -> Result<Arc<RemoteFileBrowserProxy>, RelaunchBlocked> {
    let live = manager.agent_ranged_sessions().await;
    resolve_agent_target(
        persisted,
        live,
        |proxy: Arc<RemoteFileBrowserProxy>| async move {
            proxy.probe_ranges().await.map_err(|e| e.to_string())
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn persisted(definition: Option<&str>) -> PersistedAgentTarget {
        PersistedAgentTarget {
            agent_id: "agent-1".to_string(),
            remote_session_id: "remote-old".to_string(),
            definition_id: definition.map(str::to_string),
        }
    }

    fn live(agent: &str, remote: &str, definition: Option<&str>) -> AgentSessionIdentity {
        AgentSessionIdentity {
            agent_id: agent.to_string(),
            remote_session_id: remote.to_string(),
            definition_id: definition.map(str::to_string),
        }
    }

    /// The original agent-side session wins over a reopened one of the same
    /// definition; both win over nothing.
    #[test]
    fn the_same_agent_session_ranks_before_a_reopened_definition() {
        let ranked = rank_candidates(
            &persisted(Some("def-a")),
            vec![
                (live("agent-1", "remote-new", Some("def-a")), "reopened"),
                (live("agent-1", "remote-old", Some("def-a")), "original"),
            ],
        );
        assert_eq!(ranked, vec!["original", "reopened"]);
    }

    /// Identity mismatches never match: another agent (even with the same
    /// definition or agent-side session id), another definition, or a
    /// session without one.
    #[test]
    fn mismatched_identities_are_refused() {
        let ranked = rank_candidates(
            &persisted(Some("def-a")),
            vec![
                (
                    live("agent-2", "remote-old", Some("def-a")),
                    "other agent, same ids",
                ),
                (live("agent-2", "remote-x", Some("def-a")), "other agent"),
                (
                    live("agent-1", "remote-x", Some("def-b")),
                    "other definition",
                ),
                (live("agent-1", "remote-x", None), "ad-hoc"),
            ],
        );
        assert!(ranked.is_empty(), "{ranked:?}");
    }

    /// An ad-hoc agent session (no definition) resumes only into the very
    /// same agent-side session, never into another ad-hoc one.
    #[test]
    fn an_ad_hoc_session_matches_only_itself() {
        let ranked = rank_candidates(
            &persisted(None),
            vec![
                (live("agent-1", "remote-x", None), "another ad-hoc"),
                (live("agent-1", "remote-old", None), "itself"),
            ],
        );
        assert_eq!(ranked, vec!["itself"]);
    }

    /// Empty persisted ids never match an empty live id.
    #[test]
    fn empty_ids_never_match() {
        let empty = PersistedAgentTarget {
            agent_id: String::new(),
            remote_session_id: String::new(),
            definition_id: Some(String::new()),
        };
        assert!(rank_candidates(&empty, vec![(live("", "", Some("")), ())]).is_empty());
    }

    /// No matching session keeps the row paused (it waits for the agent);
    /// it is not a failure.
    #[tokio::test]
    async fn no_match_keeps_the_row_waiting_for_the_agent() {
        let err = resolve_agent_target(
            &persisted(Some("def-a")),
            vec![(live("agent-2", "remote-x", Some("def-a")), 1)],
            |_| async { Ok(()) },
        )
        .await
        .unwrap_err();
        assert_eq!(err, RelaunchBlocked::AgentSessionUnavailable);
        assert_eq!(err.message(), AGENT_SESSION_UNAVAILABLE);
        assert!(err.message().contains("reconnect the agent"));
    }

    /// A match that refuses the ranged probe is skipped for the next one; when
    /// every match refuses, the row fails with the reason.
    #[tokio::test]
    async fn a_match_that_refuses_ranges_is_skipped_then_fails() {
        let target = resolve_agent_target(
            &persisted(Some("def-a")),
            vec![
                (live("agent-1", "remote-old", Some("def-a")), 1),
                (live("agent-1", "remote-new", Some("def-a")), 2),
            ],
            |t| async move {
                if t == 1 {
                    Err("old daemon".to_string())
                } else {
                    Ok(())
                }
            },
        )
        .await;
        assert_eq!(target, Ok(2));

        let err = resolve_agent_target(
            &persisted(Some("def-a")),
            vec![(live("agent-1", "remote-old", Some("def-a")), 1)],
            |_| async { Err("old daemon".to_string()) },
        )
        .await
        .unwrap_err();
        match err {
            RelaunchBlocked::Failed(message) => {
                assert!(message.contains("old daemon"), "{message}")
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }
}

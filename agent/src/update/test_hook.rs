//! Env-gated **test-only** hook that lets a live agent hold a `pending_update`
//! and announce it to a newly-attached desktop (#1546).
//!
//! # Why this exists
//!
//! The deferred-update (busy) path of the desktop's update banner is decided
//! *inside* the agent by [`SessionManager::request_deferred_update`], from an
//! in-memory `pending_update` that a live agent never holds under test:
//!
//! - `state.json` is read once, at startup, and never re-read;
//! - the only runtime seeder, `seed_pending_update_for_test`, is `#[cfg(test)]`
//!   and so does not exist in the shipped binary a system test drives;
//! - a staged update is not replayed to a client on attach; and
//! - the real signal arrives only from the 24-hour GitHub self-update timer
//!   behind `--allow-self-update`, which a system test cannot wait for.
//!
//! This hook closes that gap: with the env var set, the agent stages a
//! `pending_update` at startup and emits an
//! [`agent.update_available`](crate::protocol::methods::AGENT_UPDATE_AVAILABLE)
//! notification every time a client attaches — the same notification the
//! self-update timer sends, over the same channel — so the deferred path becomes
//! reachable live. Unblocks #1519 and #1520.
//!
//! # Gating
//!
//! Everything here is inert unless `TERMIHUB_AGENT_TEST_PENDING_UPDATE` is set
//! to a non-empty value: [`TestPendingUpdate::from_env`] returns `None` and both
//! call sites (`io/tcp.rs`, `io/stdio.rs`) skip. Production behaviour is byte
//! for byte unchanged. The var is deliberately not a CLI flag — it must never
//! appear in `--help` or in a desktop-built exec command.
//!
//! # Safety: the staged binary is never applied by accident
//!
//! A `pending_update` is a live grenade — the last-session-disconnect hook will
//! try to *apply* it, and a successful Unix apply swaps the agent binary and
//! re-execs. So the default staged path ([`default_binary_path`]) points at a
//! file the agent never creates. If an apply does fire (the test closes its last
//! session), [`SystemUpdateApplier`](super::SystemUpdateApplier) fails to read
//! it, logs, and — per #1401 — keeps the record. The agent goes on running the
//! binary it started with. A test that genuinely wants a real swap must opt in
//! by pointing `TERMIHUB_AGENT_TEST_PENDING_UPDATE_BINARY` at a real binary.
//!
//! # Interaction with the #1551 startup prune
//!
//! [`prune_applied_pending_update`](super::prune_applied_pending_update) drops a
//! persisted `pending_update` that the running agent has already applied. This
//! hook does not fight it, on either of the two occasions they meet:
//!
//! 1. **Same process.** The prune runs inside `SessionManager::new`, from the
//!    state loaded off disk. This hook seeds *after* the manager is built, so
//!    the prune has already run and never sees the seeded record.
//! 2. **A later process.** If the agent restarts, the prune does read the seeded
//!    record — and keeps it, by design: [`DEFAULT_VERSION`] is far newer than any
//!    real `CARGO_PKG_VERSION` (version evidence says "not applied"), and the
//!    default staged path does not exist, so it cannot be byte-identical to the
//!    running executable (binary evidence says the same). Both forms of evidence
//!    agree, and the record survives — which is what a test that restarts the
//!    agent needs. `default_pending_update_survives_the_1551_startup_prune`
//!    below pins this.
//!
//!    A test that overrides the version with something *not* newer than the
//!    running agent is opting out of that guarantee: the prune will correctly
//!    drop the record on the next startup.
//!
//! See `docs/testing.md` → "Agent deferred-update E2E hook (#1546)".

use std::path::PathBuf;

use tracing::info;

use super::notify_update_available;
use crate::io::transport::NotificationSender;
use crate::session::manager::SessionManager;
use crate::state::persistence::AgentState;

/// Master gate. Set to a non-empty value to arm the hook; the value is the
/// version to advertise, or `1`/`true`/`yes` to take [`DEFAULT_VERSION`].
pub const TEST_PENDING_UPDATE_ENV: &str = "TERMIHUB_AGENT_TEST_PENDING_UPDATE";

/// Optional override for the staged binary path. Only set this when the test
/// wants a real binary swap — see the module docs on safety.
pub const TEST_PENDING_UPDATE_BINARY_ENV: &str = "TERMIHUB_AGENT_TEST_PENDING_UPDATE_BINARY";

/// Version advertised when the gate is set to a plain truthy value. Chosen to be
/// unmistakably newer than any real release, so the #1551 startup prune keeps
/// the record and the desktop always sees an upgrade.
pub const DEFAULT_VERSION: &str = "99.99.99";

/// The staged `pending_update` a test asked the agent to hold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestPendingUpdate {
    /// Version advertised as available (`available_version` in the
    /// notification, and `version` on the persisted record).
    pub version: String,
    /// Path recorded as the staged binary. Does not exist unless the test
    /// pointed it at a real one.
    pub binary_path: String,
}

impl TestPendingUpdate {
    /// Read the hook's configuration from the environment.
    ///
    /// `None` — the production path — whenever [`TEST_PENDING_UPDATE_ENV`] is
    /// unset, empty, or explicitly falsy.
    pub fn from_env() -> Option<Self> {
        Self::parse(
            std::env::var(TEST_PENDING_UPDATE_ENV).ok(),
            std::env::var(TEST_PENDING_UPDATE_BINARY_ENV).ok(),
        )
    }

    /// Pure form of [`from_env`](Self::from_env), so the parsing rules can be
    /// tested without mutating a shared process environment.
    fn parse(gate: Option<String>, binary: Option<String>) -> Option<Self> {
        let gate = gate?;
        let gate = gate.trim();
        if gate.is_empty() || matches!(gate, "0" | "false" | "no") {
            return None;
        }
        let version = match gate {
            "1" | "true" | "yes" => DEFAULT_VERSION.to_string(),
            explicit => explicit.to_string(),
        };
        let binary_path = binary
            .map(|b| b.trim().to_string())
            .filter(|b| !b.is_empty())
            .unwrap_or_else(|| default_binary_path(&version).to_string_lossy().into_owned());
        Some(Self {
            version,
            binary_path,
        })
    }

    /// Stage the update into the agent's shared state (in memory + `state.json`).
    ///
    /// Must be called **after** the [`SessionManager`] is constructed, so the
    /// #1551 startup prune has already run against the on-disk state — see the
    /// module docs.
    pub async fn seed(&self, session_manager: &SessionManager) {
        session_manager
            .stage_pending_update(self.binary_path.clone(), self.version.clone())
            .await;
        info!(
            "TEST HOOK ({TEST_PENDING_UPDATE_ENV}): staged a pending update for version {} from {} \
             — test-only, never set this in production",
            self.version, self.binary_path
        );
    }

    /// Announce the staged update to a client that has just attached.
    ///
    /// The agent's own notification helper, so the desktop cannot tell this from
    /// a self-update-timer announcement. `staged: true` mirrors the fact that a
    /// `pending_update` record exists, which is what makes the banner's
    /// "Apply Now" reach [`SessionManager::request_deferred_update`].
    pub fn notify_attached(&self, notification_tx: &NotificationSender, current_version: &str) {
        notify_update_available(notification_tx, current_version, &self.version, None, true);
    }
}

/// Path staged by default: inside the agent's own updates directory, under a
/// name the agent never writes. Deliberately non-existent — see the module docs
/// on safety.
fn default_binary_path(version: &str) -> PathBuf {
    AgentState::config_dir()
        .join("updates")
        .join(format!("termihub-agent-test-pending-{version}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::persistence::PendingUpdate;
    use crate::update::prune_applied_pending_update;

    #[test]
    fn unset_gate_is_a_no_op() {
        assert_eq!(TestPendingUpdate::parse(None, None), None);
    }

    #[test]
    fn empty_or_falsy_gate_is_a_no_op() {
        for gate in ["", "   ", "0", "false", "no"] {
            assert_eq!(
                TestPendingUpdate::parse(Some(gate.to_string()), None),
                None,
                "gate {gate:?} must leave the hook disarmed"
            );
        }
    }

    #[test]
    fn truthy_gate_takes_the_default_version() {
        for gate in ["1", "true", "yes"] {
            let hook = TestPendingUpdate::parse(Some(gate.to_string()), None)
                .unwrap_or_else(|| panic!("gate {gate:?} must arm the hook"));
            assert_eq!(hook.version, DEFAULT_VERSION);
        }
    }

    #[test]
    fn explicit_version_is_used_verbatim() {
        let hook = TestPendingUpdate::parse(Some("v1.2.3".to_string()), None).unwrap();
        assert_eq!(hook.version, "v1.2.3");
    }

    #[test]
    fn default_binary_path_is_used_when_no_override_is_given() {
        let hook = TestPendingUpdate::parse(Some("1".to_string()), None).unwrap();
        assert_eq!(
            hook.binary_path,
            default_binary_path(DEFAULT_VERSION).to_string_lossy()
        );
    }

    /// The default staged path must not exist — an apply that fires against it
    /// has to fail harmlessly rather than swap the running agent's binary.
    #[test]
    fn default_binary_path_does_not_exist() {
        assert!(
            !default_binary_path(DEFAULT_VERSION).exists(),
            "the default staged path must never be a real binary"
        );
    }

    #[test]
    fn binary_override_wins_and_blank_override_falls_back() {
        let hook =
            TestPendingUpdate::parse(Some("1".to_string()), Some("/tmp/real-agent".to_string()))
                .unwrap();
        assert_eq!(hook.binary_path, "/tmp/real-agent");

        let hook = TestPendingUpdate::parse(Some("1".to_string()), Some("  ".to_string())).unwrap();
        assert_eq!(
            hook.binary_path,
            default_binary_path(DEFAULT_VERSION).to_string_lossy()
        );
    }

    /// #1551 sweeps an already-applied `pending_update` at startup. The record
    /// this hook stages by default must survive that sweep, so an agent restart
    /// mid-test does not silently disarm the hook.
    #[test]
    fn default_pending_update_survives_the_1551_startup_prune() {
        let hook = TestPendingUpdate::parse(Some("1".to_string()), None).unwrap();
        let mut state = AgentState::default();
        state.update.pending_update = Some(PendingUpdate {
            version: hook.version.clone(),
            binary_path: hook.binary_path.clone(),
            staged_at: "2026-07-17T09:00:00Z".to_string(),
        });

        let current_exe = std::env::current_exe().ok();
        assert!(
            !prune_applied_pending_update(
                &mut state,
                env!("CARGO_PKG_VERSION"),
                current_exe.as_deref()
            ),
            "the seeded test update must not look already-applied to the #1551 prune"
        );
        assert!(state.update.pending_update.is_some());
    }
}

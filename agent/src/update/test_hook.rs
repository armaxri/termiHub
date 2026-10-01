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
//! This whole module is compiled out of release builds (audit finding AGT-008):
//! it exists only under `debug_assertions` (every `cargo test` / dev build) or
//! when the `test-hooks` cargo feature is explicitly enabled. See the gate on
//! `mod test_hook;` and on [`super::TestUpdateHook`] in `update/mod.rs`. A
//! shipped `cargo build --release` contains neither this code nor the env lookup
//! that arms it, so the self-update path cannot be redirected at an arbitrary
//! binary through an environment variable on a released agent.
//!
//! Even when compiled in, everything here is inert unless
//! `TERMIHUB_AGENT_TEST_PENDING_UPDATE` is set to a non-empty value:
//! [`TestPendingUpdate::from_env`] returns `None` and the transport loops
//! (`io/tcp.rs`, `io/stdio.rs`, via [`super::TestUpdateHook`]) do nothing.
//! Production behaviour is byte for byte unchanged. The var is deliberately not a
//! CLI flag — it must never appear in `--help` or in a desktop-built exec
//! command.
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
//! # A real swap (#4083)
//!
//! The apply path runs every production gate — confinement (AGT-003), the
//! SHA-256 digest (AGT-004) and the Ed25519 signature (AGT-005) — and this hook
//! bypasses none of them. To let a release-built `test-hooks` agent really swap:
//!
//! - [`TEST_PENDING_UPDATE_SHA256_ENV`] carries the staged binary's expected
//!   digest into the record (without it the apply fails closed at AGT-004);
//! - the signature is read from the `<binary>.sig` sidecar next to the staged
//!   binary, as a published release asset carries it. The armed
//!   `remote-agent-update-swap` image signs with the committed TEST-ONLY key,
//!   which only a `test-hooks` build trusts
//!   ([`agent_policy`](super::signature::agent_policy));
//! - once the swap happened, the re-execed agent (and every later worker
//!   launched with the same environment) is running the staged bytes. The hook
//!   then **stands down** ([`TestPendingUpdate::already_applied`]) instead of
//!   re-staging an update that is already installed — the same binary evidence
//!   the #1551 startup prune uses.
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

use std::path::{Path, PathBuf};

use tracing::info;

use super::apply::files_identical;
use super::notify_update_available;
use super::signature::signature_sidecar_path;
use crate::io::transport::NotificationSender;
use crate::session::manager::SessionManager;
use crate::state::persistence::AgentState;

/// Master gate. Set to a non-empty value to arm the hook; the value is the
/// version to advertise, or `1`/`true`/`yes` to take [`DEFAULT_VERSION`].
pub const TEST_PENDING_UPDATE_ENV: &str = "TERMIHUB_AGENT_TEST_PENDING_UPDATE";

/// Optional override for the staged binary path. Only set this when the test
/// wants a real binary swap — see the module docs on safety.
pub const TEST_PENDING_UPDATE_BINARY_ENV: &str = "TERMIHUB_AGENT_TEST_PENDING_UPDATE_BINARY";

/// Optional expected SHA-256 (hex) of the staged binary, recorded as the
/// pending update's `expected_sha256` so a real apply passes the AGT-004 digest
/// gate (#4083). Unset, the record carries no digest and an apply fails closed.
pub const TEST_PENDING_UPDATE_SHA256_ENV: &str = "TERMIHUB_AGENT_TEST_PENDING_UPDATE_SHA256";

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
    /// Expected SHA-256 of the staged binary (AGT-004), if the test supplied
    /// one through [`TEST_PENDING_UPDATE_SHA256_ENV`].
    pub expected_sha256: Option<String>,
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
        .map(|hook| hook.with_sha256(std::env::var(TEST_PENDING_UPDATE_SHA256_ENV).ok()))
    }

    /// Record `sha256` (trimmed, lowercased) as the expected digest; a blank
    /// value is ignored.
    fn with_sha256(mut self, sha256: Option<String>) -> Self {
        self.expected_sha256 = sha256
            .map(|d| d.trim().to_ascii_lowercase())
            .filter(|d| !d.is_empty());
        self
    }

    /// Whether the staged binary is already the running one — the update was
    /// applied and this process is its result (#4083). Binary evidence only,
    /// exactly as the #1551 prune judges it: `current_exe` and the staged file
    /// are byte-identical. A missing staged file (the default path) is never
    /// "applied".
    pub fn already_applied(&self, current_exe: Option<&Path>) -> bool {
        current_exe.is_some_and(|exe| files_identical(Path::new(&self.binary_path), exe))
    }

    /// The detached signature published next to the staged binary
    /// (`<binary>.sig`), if there is one. Missing → `None`, which a release
    /// build's apply refuses (AGT-005).
    fn sidecar_signature(&self) -> Option<String> {
        let sidecar = signature_sidecar_path(Path::new(&self.binary_path));
        std::fs::read_to_string(sidecar)
            .ok()
            .map(|sig| sig.trim().to_string())
            .filter(|sig| !sig.is_empty())
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
            expected_sha256: None,
        })
    }

    /// Stage the update into the agent's shared state (in memory + `state.json`).
    ///
    /// Must be called **after** the [`SessionManager`] is constructed, so the
    /// #1551 startup prune has already run against the on-disk state — see the
    /// module docs.
    pub async fn seed(&self, session_manager: &SessionManager) {
        // The digest and signature are carried only when the test supplied
        // them (#4083). Without them — the default — the apply fails closed at
        // AGT-004/AGT-005 (and, for the default path, already at confinement),
        // so the hook only surfaces the banner / deferred RPC. With them, the
        // apply still runs every production gate before it swaps.
        let signature = self.sidecar_signature();
        session_manager
            .stage_pending_update(
                self.binary_path.clone(),
                self.version.clone(),
                self.expected_sha256.clone(),
                signature.clone(),
            )
            .await;
        info!(
            "TEST HOOK ({TEST_PENDING_UPDATE_ENV}): staged a pending update for version {} from {} \
             (digest: {}, signature: {}) — test-only, never set this in production",
            self.version,
            self.binary_path,
            if self.expected_sha256.is_some() { "set" } else { "none" },
            if signature.is_some() { "sidecar" } else { "none" },
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

    /// The real production entry point [`TestPendingUpdate::from_env`] — not just
    /// the pure [`TestPendingUpdate::parse`] — must be disarmed when the gate is
    /// absent. Clears the env first (mirroring the live suite's hygiene) so a
    /// developer who happens to export the var cannot make this pass spuriously.
    /// This is the arm the AGT-008 gate compiles out of release builds; here we
    /// pin that, when it IS compiled in, an unset gate arms nothing.
    #[test]
    fn from_env_is_disarmed_when_the_gate_is_absent() {
        std::env::remove_var(TEST_PENDING_UPDATE_ENV);
        std::env::remove_var(TEST_PENDING_UPDATE_BINARY_ENV);
        assert_eq!(TestPendingUpdate::from_env(), None);
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
            expected_sha256: None,
            signature: None,
            pinned_version: None,
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

    // ── #4083: digest, sidecar signature, stand-down after a real swap ──

    #[test]
    fn default_hook_carries_no_digest() {
        let hook = TestPendingUpdate::parse(Some("1".to_string()), None).unwrap();
        assert_eq!(hook.expected_sha256, None);
        assert_eq!(hook.sidecar_signature(), None);
    }

    #[test]
    fn sha256_is_trimmed_and_lowercased_and_blank_is_ignored() {
        let hook = TestPendingUpdate::parse(Some("1".to_string()), None).unwrap();
        let set = hook.clone().with_sha256(Some("  ABCDEF01\n".to_string()));
        assert_eq!(set.expected_sha256.as_deref(), Some("abcdef01"));
        assert_eq!(
            hook.clone()
                .with_sha256(Some("  ".to_string()))
                .expected_sha256,
            None
        );
        assert_eq!(hook.with_sha256(None).expected_sha256, None);
    }

    #[test]
    fn signature_is_read_from_the_sidecar_next_to_the_staged_binary() {
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("termihub-agent-staged");
        std::fs::write(&staged, b"BINARY").unwrap();
        let hook = TestPendingUpdate::parse(
            Some("9.9.9".to_string()),
            Some(staged.to_string_lossy().into_owned()),
        )
        .unwrap();
        assert_eq!(hook.sidecar_signature(), None, "no sidecar yet");
        std::fs::write(signature_sidecar_path(&staged), "  c2lnbmF0dXJl\n").unwrap();
        assert_eq!(hook.sidecar_signature().as_deref(), Some("c2lnbmF0dXJl"));
    }

    #[test]
    fn hook_stands_down_only_when_the_staged_binary_is_the_running_one() {
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("staged");
        let running = dir.path().join("running");
        std::fs::write(&staged, b"NEW-AGENT").unwrap();
        std::fs::write(&running, b"OLD-AGENT").unwrap();
        let hook = TestPendingUpdate::parse(
            Some("9.9.9".to_string()),
            Some(staged.to_string_lossy().into_owned()),
        )
        .unwrap();
        assert!(!hook.already_applied(Some(&running)), "not swapped yet");
        assert!(!hook.already_applied(None), "unknown exe proves nothing");

        std::fs::copy(&staged, &running).unwrap();
        assert!(hook.already_applied(Some(&running)), "swapped: stand down");

        // The default staged path never exists, so it is never "applied".
        let default = TestPendingUpdate::parse(Some("1".to_string()), None).unwrap();
        assert!(!default.already_applied(Some(&running)));
    }
}

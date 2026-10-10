//! Agent state persistence for session recovery after restart.
//!
//! Tracks running sessions with their daemon socket paths so the agent
//! can reconnect to surviving daemon processes on startup.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use termihub_core::connection::secrets::FALLBACK_SECRET_KEYS;
use tracing::{debug, error, warn};

use crate::store_version::{check_version, guard_not_newer};

/// Current schema version stamped into every freshly written `state.json`.
///
/// A file written before this field existed deserializes with `version == 0`
/// (`#[serde(default)]` → `u32::default()`) and is treated as the v1 baseline
/// by the version gate ([`crate::store_version`]). A file whose version is
/// **newer** than this is never interpreted and never overwritten (#2744): a
/// downgraded agent must not erase what a newer agent wrote.
///
/// When the schema changes, bump this and add a numbered step to
/// [`migrate_state`].
pub const CURRENT_STATE_VERSION: u32 = 1;

/// Diagnostic store name used in version-gate errors.
const STATE_STORE: &str = "state.json";

/// Persisted agent state written to `state.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentState {
    /// Schema version of the on-disk file (see [`CURRENT_STATE_VERSION`]).
    ///
    /// `#[serde(default)]` so a pre-versioning `state.json` still loads (it reads
    /// back as `0`); [`AgentState::save_to`] always writes the current version.
    #[serde(default)]
    pub version: u32,
    pub sessions: HashMap<String, PersistedSession>,
    /// Self-update bookkeeping (last GitHub poll time, staged pending update).
    ///
    /// `#[serde(default)]` so a `state.json` written by an agent that predates
    /// the self-update feature still loads (the field defaults to empty).
    #[serde(default)]
    pub update: UpdateState,
    /// Unknown top-level keys, captured verbatim so an older agent preserves
    /// fields a newer version added rather than dropping them on save (PER-010).
    ///
    /// Without this catch-all, a downgrade/rollback (the agent auto-updates)
    /// would erase everything a newer agent wrote into `state.json` on the next
    /// load→save cycle. Empty by default, so a flattened empty map contributes
    /// nothing to the serialized output. Matches the sibling stores' idiom
    /// (`AppSettings`, `WorkspaceStore`, `LastSession`, `SessionHistory`).
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
    /// Set when this in-memory state was loaded from a file that must not be
    /// overwritten: one written by a newer schema version, or a corrupt one
    /// whose bytes could not be backed up first (#2744). [`AgentState::save_to`]
    /// refuses to write while this is set. Never serialized.
    #[serde(skip)]
    write_blocked: bool,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            version: CURRENT_STATE_VERSION,
            sessions: HashMap::new(),
            update: UpdateState::default(),
            extra: serde_json::Map::new(),
            write_blocked: false,
        }
    }
}

/// Self-update state persisted across agent restarts (#1355).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct UpdateState {
    /// RFC 3339 timestamp of the last GitHub `releases/latest` poll, or `None`
    /// if the agent has never polled.
    #[serde(default)]
    pub last_check_time: Option<String>,
    /// A downloaded-and-verified binary awaiting application, or `None`.
    #[serde(default)]
    pub pending_update: Option<PendingUpdate>,
}

/// An agent binary that has been staged (downloaded + SHA-256-verified, or
/// pushed via `agent.request_deferred_update`) but not yet applied.
///
/// The deferred apply (SI-6, #1352) is wired: the agent applies this when its
/// last session disconnects, or immediately via `agent.request_deferred_update`
/// when it is idle — see [`crate::session::manager::SessionManager`] and the
/// `crate::update::apply` module. A *self-update* staged by the background timer
/// now flows through the same path and auto-applies on idle (#1401), gated on
/// the connection's update strategy; a failed apply keeps this record for retry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingUpdate {
    /// Target version (release tag semver, e.g. `"0.3.0"`).
    pub version: String,
    /// Absolute path to the staged, verified binary.
    pub binary_path: String,
    /// RFC 3339 timestamp when the binary was staged.
    pub staged_at: String,
    /// Expected lowercase-hex SHA-256 digest of the staged binary, carried from
    /// the route that staged it (self-update download sidecar, or the
    /// desktop-computed digest sent with `agent.request_update`). The apply path
    /// **re-verifies** the on-disk bytes against this digest immediately before
    /// the swap (AGT-004), closing the stage-then-tamper TOCTOU window. `None`
    /// means no digest was carried — the apply path treats that as a fail-closed
    /// rejection, never a skip. `#[serde(default)]` keeps older `state.json`
    /// files (written before this field existed) loadable as `None`.
    #[serde(default)]
    pub expected_sha256: Option<String>,
    /// Detached Ed25519 signature (base64) over the domain-separated
    /// `expected_sha256`, carried from the route that staged the update (the
    /// downloaded `.sig` sidecar, or the `signature` sent with
    /// `agent.request_update`). The apply path verifies it against the agent's
    /// compiled-in release key before the swap (AGT-005, #3213); `None` fails
    /// closed in a release build. `#[serde(default)]` keeps older `state.json`
    /// files loadable as `None`.
    #[serde(default)]
    pub signature: Option<String>,
    /// The desktop's matched-downgrade pin (SEC-006, #3213), carried from
    /// `agent.request_update` / `agent.request_deferred_update` after the RPC
    /// layer bound it to the requesting desktop's version. The apply path
    /// accepts a binary older than the running agent only when its embedded
    /// version equals this pin. `None` for self-downloaded updates and for
    /// `state.json` files written before this field existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_version: Option<String>,
}

/// Minimal session info stored for recovery.
///
/// Stores the connection type ID and settings JSON so the session can
/// be reconnected by spawning a new daemon or recreating the connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedSession {
    /// Connection type identifier (e.g., `"local"`, `"ssh"`, `"docker"`).
    pub type_id: String,
    pub title: String,
    pub created_at: String,
    /// Path to the daemon Unix socket.
    pub daemon_socket: Option<String>,
    /// Connection settings, **with plaintext secrets redacted** before writing
    /// (see [`redact_persisted_secrets`], AGT-021).
    ///
    /// Recovery reattaches to the surviving daemon over its socket
    /// (`recover_sessions`) — it never re-handshakes from these settings — and
    /// the snapshot reported to the desktop does not include settings, so the
    /// secret values are never needed from disk. What is kept is enough to
    /// report a recovered session's shape (host/port/type) after a restart.
    pub settings: serde_json::Value,
    /// ID of the saved connection definition this session was created from.
    /// Survives agent restart so clients can re-link a recovered session
    /// to its source definition.
    #[serde(default)]
    pub definition_id: Option<String>,
}

/// Whether the settings key `key` carries a plaintext secret, matched
/// case-insensitively against the core classifier's built-in secret keys
/// ([`FALLBACK_SECRET_KEYS`]): SSH/FTP/RDP/VNC and jump-host `password` (which
/// also holds a key **passphrase** for key auth — see
/// `core::backends::ssh::auth`), and the VNC SSH-gateway `sshPassword`. Agents
/// host only built-in types, whose schema secrets that list covers (#4289).
fn is_secret_settings_key(key: &str) -> bool {
    FALLBACK_SECRET_KEYS
        .iter()
        .any(|secret| secret.eq_ignore_ascii_case(key))
}

/// Object keys whose *values* are free-form user data we must not walk into:
/// `env`/`envVars` map arbitrary user-named variables to values we cannot
/// classify as secret or not, so redacting inside them is out of scope
/// (AGT-021) — a variable a user happens to name `password` is left alone.
const OPAQUE_SETTINGS_SUBTREES: &[&str] = &["env", "envvars", "env_vars"];

/// Return a copy of `settings` with every known plaintext-secret field removed,
/// for persisting to `state.json`.
///
/// Walks the JSON recursively so nested secrets are covered too — a jump-host
/// hop's `password` inside the `proxyJump` array, or a tunnelled VNC's
/// `sshPassword` — while never descending into `env`/`envVars` subtrees, whose
/// user-defined values cannot be classified (documented residual, AGT-021).
/// Secret keys are dropped entirely rather than nulled, so a dump of
/// `state.json` shows no secret-named field at all. The live (unredacted)
/// settings stay with the daemon (handed over stdin) and in the in-memory
/// `SessionInfo` for the current session; only the on-disk copy is scrubbed.
pub fn redact_persisted_secrets(settings: &serde_json::Value) -> serde_json::Value {
    let mut redacted = settings.clone();
    redact_in_place(&mut redacted);
    redacted
}

fn redact_in_place(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            map.retain(|k, _| !is_secret_settings_key(k));
            for (k, v) in map.iter_mut() {
                if OPAQUE_SETTINGS_SUBTREES.contains(&k.to_ascii_lowercase().as_str()) {
                    continue;
                }
                redact_in_place(v);
            }
        }
        serde_json::Value::Array(items) => {
            for v in items.iter_mut() {
                redact_in_place(v);
            }
        }
        _ => {}
    }
}

impl AgentState {
    /// Load state from a specific path.
    ///
    /// A **missing** file is normal → returns empty state quietly. Otherwise the
    /// file is never silently discarded (AGT-017, PER-006, #2744):
    ///
    /// * **Newer schema version** (written by a newer agent before a downgrade):
    ///   the file is not interpreted and is left intact; the returned state is
    ///   empty and write-blocked, so no save can overwrite it.
    /// * **Valid JSON with a malformed part** (e.g. one bad session): the
    ///   original bytes are copied aside to a `state.json.bak[.N]` backup, then
    ///   every well-formed session, the update record and unknown keys are
    ///   salvaged.
    /// * **Unparseable JSON**: the bytes are copied to the same shared
    ///   `state.json.bak[.N]` backup scheme, the live file is cleared, and a loud
    ///   `error!` names the backup before continuing with empty state.
    ///
    /// If a backup is impossible, the returned state is write-blocked so the
    /// only copy of the data is never overwritten.
    pub fn load_from(path: &Path) -> Self {
        let contents = match std::fs::read_to_string(path) {
            Ok(contents) => contents,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                debug!("No agent state file at {}", path.display());
                return Self::default();
            }
            Err(e) => {
                // The file exists but could not be read (e.g. permissions). Do
                // not silently pretend there were no sessions — surface it, and
                // never overwrite what we could not read.
                warn!(
                    "Failed to read agent state from {}: {}; starting with empty state \
                     (the file will not be overwritten)",
                    path.display(),
                    e
                );
                return Self::blocked();
            }
        };

        let mut value = match serde_json::from_str::<serde_json::Value>(&contents) {
            Ok(value) if value.is_object() => value,
            Ok(_) => return Self::quarantine(path, "top-level value is not an object"),
            Err(e) => return Self::quarantine(path, &e.to_string()),
        };

        let found = match check_version(&value, STATE_STORE, CURRENT_STATE_VERSION) {
            Ok(found) => found,
            Err(newer) => {
                error!(
                    "{newer} ({}); starting with empty state and leaving the file intact",
                    path.display()
                );
                return Self::blocked();
            }
        };
        migrate_state(&mut value, found);
        // Normalise the version so a string-typed `"1"` (the shared store
        // convention) deserializes into the numeric field. A legacy versionless
        // file keeps reading back as 0.
        if let Some(obj) = value.as_object_mut() {
            if obj.contains_key("version") {
                obj.insert("version".to_string(), serde_json::json!(found));
            }
        }

        match serde_json::from_value::<AgentState>(value.clone()) {
            Ok(state) => {
                debug!(
                    "Loaded agent state (version {}) with {} sessions from {}",
                    state.version,
                    state.sessions.len(),
                    path.display()
                );
                state
            }
            Err(e) => Self::salvage(path, &contents, value, &e.to_string()),
        }
    }

    /// Empty state that refuses every save (see `write_blocked`).
    fn blocked() -> Self {
        Self {
            write_blocked: true,
            ..Self::default()
        }
    }

    /// Unparseable file: back it up to `state.json.bak[.N]` and start empty; if
    /// that fails, start empty but write-blocked so the corrupt bytes are never
    /// overwritten.
    fn quarantine(path: &Path, reason: &str) -> Self {
        match backup_corrupt_state(path) {
            Ok(backup) => {
                error!(
                    "Agent state at {} is corrupt ({}); backed up to {} and started with \
                     empty state — recoverable sessions are preserved in the backup",
                    path.display(),
                    reason,
                    backup.display()
                );
                Self::default()
            }
            Err(e) => {
                error!(
                    "Agent state at {} is corrupt ({}) and could NOT be backed up ({}); \
                     starting with empty state and leaving the file untouched",
                    path.display(),
                    reason,
                    e
                );
                Self::blocked()
            }
        }
    }

    /// Valid JSON that does not match the schema: back the bytes up, then keep
    /// every part that still deserializes on its own.
    fn salvage(path: &Path, contents: &str, value: serde_json::Value, reason: &str) -> Self {
        let backup = match crate::store_version::backup_corrupt(path, contents.as_bytes()) {
            Ok(backup) => backup,
            Err(e) => {
                error!(
                    "Agent state at {} is malformed ({}) and could NOT be backed up ({}); \
                     starting with empty state and leaving the file untouched",
                    path.display(),
                    reason,
                    e
                );
                return Self::blocked();
            }
        };

        let serde_json::Value::Object(mut obj) = value else {
            unreachable!("load_from only salvages JSON objects");
        };
        let mut state = Self {
            version: obj
                .remove("version")
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or(0),
            ..Self::default()
        };
        let mut dropped = 0usize;
        if let Some(serde_json::Value::Object(sessions)) = obj.remove("sessions") {
            for (id, raw) in sessions {
                match serde_json::from_value::<PersistedSession>(raw) {
                    Ok(session) => {
                        state.sessions.insert(id, session);
                    }
                    Err(_) => dropped += 1,
                }
            }
        }
        if let Some(update) = obj.remove("update") {
            state.update = serde_json::from_value(update).unwrap_or_default();
        }
        state.extra = obj;
        error!(
            "Agent state at {} is malformed ({}); backed up to {} and salvaged {} session(s), \
             dropped {} unreadable session(s)",
            path.display(),
            reason,
            backup.display(),
            state.sessions.len(),
            dropped
        );
        state
    }

    /// Save state to a specific path.
    ///
    /// Refuses (with a warning) when this state was loaded from a file that must
    /// not be overwritten, or when the file on disk is now a **newer** schema
    /// version — re-checked at write time, so a newer agent's write between our
    /// load and this save is protected too (#2744).
    pub fn save_to(&self, path: &Path) {
        if self.write_blocked {
            warn!(
                "Not writing agent state to {}: the file on disk is protected \
                 (newer version or unbacked-up corrupt data)",
                path.display()
            );
            return;
        }
        if let Err(newer) = guard_not_newer(path, STATE_STORE, CURRENT_STATE_VERSION) {
            warn!("Not writing agent state to {}: {newer}", path.display());
            return;
        }
        if let Some(parent) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                warn!(
                    "Failed to create state directory {}: {}",
                    parent.display(),
                    e
                );
                return;
            }
        }
        // Always re-stamp the current schema version on write: the in-memory
        // state is by definition the current shape, so a re-saved legacy file
        // (which loaded as version 0) is transparently upgraded to the current
        // version.
        let mut to_write = self.clone();
        to_write.version = CURRENT_STATE_VERSION;
        match serde_json::to_string_pretty(&to_write) {
            Ok(json) => {
                // Atomic write (temp + rename) so a crash mid-write can never
                // truncate state.json and lose the persisted session state (#2366).
                match crate::fs::write_atomic(path, &json) {
                    // Restrict to owner-only right after the write (AGT-021).
                    Ok(()) => restrict_state_permissions(path),
                    Err(e) => {
                        warn!("Failed to write agent state to {}: {:#}", path.display(), e)
                    }
                }
            }
            Err(e) => {
                warn!("Failed to serialize agent state: {}", e);
            }
        }
    }

    /// Cross-process-safe read-modify-write of the shared on-disk state.
    ///
    /// Acquires an exclusive advisory lock on `path`'s sidecar lock-file, then
    /// **re-reads the current on-disk state**, applies `delta`, and writes the
    /// result atomically before releasing the lock. Re-reading under the lock is
    /// what closes the multi-worker lost-update window (AGT-016): a peer worker's
    /// concurrent insert/remove is merged in rather than clobbered by a stale
    /// whole-struct save. Callers should pass a *delta* (insert one session,
    /// remove one session, set one update field) rather than a whole snapshot.
    ///
    /// Returns the merged state so the caller can refresh its in-memory copy to
    /// match the on-disk truth. If the lock cannot be acquired (e.g. the lock
    /// file is unwritable) it degrades to an unlocked read-modify-write and logs
    /// a warning — the same behaviour as before this guard existed, never a lost
    /// save.
    pub fn mutate_locked(path: &Path, delta: impl FnOnce(&mut AgentState)) -> AgentState {
        let _lock = match crate::fs::FileLock::acquire(path) {
            Ok(lock) => Some(lock),
            Err(e) => {
                warn!(
                    "Could not acquire cross-process lock for {}: {:#}; \
                     proceeding without it (a concurrent worker could lose an update)",
                    path.display(),
                    e
                );
                None
            }
        };
        let mut state = AgentState::load_from(path);
        delta(&mut state);
        state.save_to(path);
        state
    }

    /// The default `state.json` path under the platform config dir.
    ///
    /// Resolves to `$XDG_CONFIG_HOME/termihub-agent/state.json` on Linux,
    /// `~/Library/Application Support/termihub-agent/state.json` on macOS,
    /// and `%APPDATA%\termihub-agent\state.json` on Windows.
    pub fn default_path() -> PathBuf {
        Self::config_dir().join("state.json")
    }

    /// The platform config directory the agent stores its state under.
    pub fn config_dir() -> PathBuf {
        config_dir()
    }
}

/// Forward-migrate a parsed `state.json` from schema `from` to
/// [`CURRENT_STATE_VERSION`] in place.
///
/// There is only one schema so far (a versionless legacy file is the v1
/// baseline), so this is the identity. When the schema changes, add a numbered
/// step here (`if from < 2 { … }`) and bump [`CURRENT_STATE_VERSION`].
fn migrate_state(_value: &mut serde_json::Value, _from: u32) {}

/// Restrict `state.json` to owner-only (`0o600`) access after it is written
/// (AGT-021).
///
/// `state.json` stores each session's full connection settings JSON, so on a
/// multi-user host it must never be readable by other local users. The atomic
/// write routes through a `tempfile` temp file that is already created `0o600`,
/// and the persist-rename preserves that mode — so there is no world-readable
/// window. We nonetheless set the mode explicitly rather than relying on that
/// implementation detail, so the owner-only guarantee holds even if the write
/// path ever changes (e.g. a switch back to a umask-respecting write).
/// Best-effort: a failure is logged, not fatal — the state is already written.
#[cfg(unix)]
fn restrict_state_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        warn!(
            "Failed to restrict permissions on agent state {}: {}",
            path.display(),
            e
        );
    }
}

/// No-op on non-unix: on Windows the state lives under `%APPDATA%`, whose NTFS
/// ACLs already restrict it to the owner's profile, and there is no `chmod`
/// analog to apply (AGT-021).
#[cfg(not(unix))]
fn restrict_state_permissions(_path: &Path) {}

/// Quarantine an unparseable `state.json`: copy its bytes to the first free
/// `state.json.bak[.N]` slot (fsynced, via the shared
/// [`termihub_core::util::persist::backup_corrupt_file`]), then clear the live
/// path.
///
/// Clearing the live file keeps a later read-only load from backing the same
/// bytes up again (and so from exhausting the bounded slots). It happens only
/// once the backup is durable, so the corrupt bytes always exist on disk in at
/// least one place. Returns the backup path, or the error when no backup could
/// be made — the caller then write-blocks the state so nothing overwrites the
/// only copy.
fn backup_corrupt_state(path: &Path) -> std::io::Result<PathBuf> {
    let backup = termihub_core::util::persist::backup_corrupt_file(path)?;
    sync_parent_dir(&backup);
    if let Err(e) = std::fs::remove_file(path) {
        // The backup exists, so the live file may still be overwritten by the
        // next save; it is only left in place.
        warn!(
            "Backed up corrupt agent state {} to {} but could not remove it: {}",
            path.display(),
            backup.display(),
            e
        );
    }
    Ok(backup)
}

/// Best-effort fsync of `path`'s directory, so a new backup's directory entry
/// is durable before the original it copies is removed.
#[cfg(unix)]
fn sync_parent_dir(path: &Path) {
    if let Some(dir) = path.parent() {
        if let Err(e) = std::fs::File::open(dir).and_then(|d| d.sync_all()) {
            debug!("Could not fsync directory {}: {}", dir.display(), e);
        }
    }
}

/// No-op on non-unix: directories cannot be opened for an fsync there.
#[cfg(not(unix))]
fn sync_parent_dir(_path: &Path) {}

/// Platform config directory for the agent.
///
/// Honors `XDG_CONFIG_HOME` first on every platform (used by integration
/// tests and portable setups to redirect the agent's state to a sandbox).
/// Otherwise delegates to the `dirs` crate, which resolves `$HOME/.config`
/// on Linux, `~/Library/Application Support` on macOS, and `%APPDATA%`
/// (Roaming) on Windows. Falls back to a relative `.config/termihub-agent`
/// only as a last resort if `dirs` cannot resolve a user config directory.
fn config_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("termihub-agent");
        }
    }
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from(".config"))
        .join("termihub-agent")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn redaction_covers_every_secret_field_an_agent_backend_declares() {
        // The schema is the source of truth for secrets (#4289): every secret
        // field of every type this agent hosts must be redacted at rest.
        let registry = crate::registry::build_registry();
        for info in registry.available_types() {
            for key in termihub_core::connection::secrets::schema_secret_keys(&info.schema) {
                let settings = json!({ key.clone(): "s3cr3t" });
                assert_eq!(
                    redact_persisted_secrets(&settings),
                    json!({}),
                    "{}.{key} survives redaction",
                    info.type_id
                );
            }
        }
    }

    #[test]
    fn redact_persisted_secrets_strips_secret_fields_keeps_the_rest() {
        let settings = json!({
            "host": "target.example",
            "port": 22,
            "username": "me",
            "authMethod": "password",
            "password": "s3cr3t",
            "sshPassword": "gateway-pw",
            "savePassword": true,
        });

        let redacted = redact_persisted_secrets(&settings);

        // Secrets gone entirely (not merely nulled)…
        assert!(
            redacted.get("password").is_none(),
            "password must be dropped"
        );
        assert!(
            redacted.get("sshPassword").is_none(),
            "sshPassword must be dropped"
        );
        // … while non-secret fields survive untouched, including the
        // similarly-named but non-secret `savePassword` flag.
        assert_eq!(redacted["host"], "target.example");
        assert_eq!(redacted["port"], 22);
        assert_eq!(redacted["username"], "me");
        assert_eq!(redacted["authMethod"], "password");
        assert_eq!(redacted["savePassword"], true);

        // The input value is not mutated — the live copy keeps its secrets.
        assert_eq!(settings["password"], "s3cr3t");
    }

    #[test]
    fn redact_persisted_secrets_strips_nested_jump_host_and_leaves_env_alone() {
        let settings = json!({
            "host": "target.example",
            "password": "top-level-pw",
            "proxyJump": [
                { "host": "bastion", "username": "jump", "password": "hop-pw" },
            ],
            // User-defined env values are opaque: a variable a user names
            // "password" must be left alone (documented residual).
            "env": { "PASSWORD": "user-env-value", "FOO": "bar" },
        });

        let redacted = redact_persisted_secrets(&settings);

        assert!(redacted.get("password").is_none());
        assert!(
            redacted["proxyJump"][0].get("password").is_none(),
            "a jump-host hop password must be redacted too"
        );
        assert_eq!(redacted["proxyJump"][0]["host"], "bastion");
        // env subtree is preserved verbatim, even a `PASSWORD`-named variable.
        assert_eq!(redacted["env"]["PASSWORD"], "user-env-value");
        assert_eq!(redacted["env"]["FOO"], "bar");
    }

    fn make_session(type_id: &str, socket: Option<&str>) -> PersistedSession {
        PersistedSession {
            type_id: type_id.to_string(),
            title: "Test".to_string(),
            created_at: "2026-02-20T10:00:00Z".to_string(),
            daemon_socket: socket.map(|s| s.to_string()),
            settings: json!({}),
            definition_id: None,
        }
    }

    #[test]
    fn save_and_load_round_trip() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        let mut state = AgentState::default();
        state.sessions.insert(
            "sess-1".to_string(),
            make_session("local", Some("/tmp/test.sock")),
        );
        state
            .sessions
            .insert("sess-2".to_string(), make_session("serial", None));
        state.save_to(&path);

        let loaded = AgentState::load_from(&path);
        assert_eq!(loaded.sessions.len(), 2);
        assert!(loaded.sessions.contains_key("sess-1"));
        assert!(loaded.sessions.contains_key("sess-2"));

        let s1 = &loaded.sessions["sess-1"];
        assert_eq!(s1.type_id, "local");
        assert_eq!(s1.daemon_socket.as_deref(), Some("/tmp/test.sock"));
    }

    #[test]
    fn missing_file_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("nonexistent.json");
        let state = AgentState::load_from(&path);
        assert!(state.sessions.is_empty());
    }

    #[test]
    fn corrupt_file_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        std::fs::write(&path, "not valid json!!!").unwrap();

        let state = AgentState::load_from(&path);
        assert!(state.sessions.is_empty());
    }

    #[test]
    fn corrupt_file_is_backed_up_not_discarded() {
        // A corrupt state.json must never be silently dropped: its bytes are
        // copied to the shared `state.json.bak` slot so recoverable sessions can
        // be salvaged (AGT-017, PER-006, #4548). Regression test — without the
        // backup this fails (no sibling file, original gone).
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        let bad = r#"{ "sessions": { truncated..."#;
        std::fs::write(&path, bad).unwrap();

        let state = AgentState::load_from(&path);
        assert!(state.sessions.is_empty(), "corrupt load must be empty");

        // The bytes were preserved verbatim in the backup, not lost.
        let backup = tmp.path().join("state.json.bak");
        assert!(
            backup.exists(),
            "corrupt file must be backed up, not discarded"
        );
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), bad);
        // The live path is cleared once the backup is durable, and the legacy
        // `.corrupt-<n>` scheme is gone.
        assert!(!path.exists(), "live corrupt file is cleared after backup");
        assert!(!tmp.path().join("state.json.corrupt-1").exists());

        // A later load (read-only or not) does not back the same bytes up again.
        AgentState::load_from(&path);
        assert!(!tmp.path().join("state.json.bak.1").exists());

        // The fresh state saves cleanly over the cleared path.
        state.save_to(&path);
        assert!(AgentState::load_from(&path).sessions.is_empty());
        assert!(!tmp.path().join("state.json.bak.1").exists());
    }

    #[test]
    fn repeated_corruption_keeps_earlier_backups() {
        // A second corruption must not clobber the first backup — it takes the
        // next free `.bak.N` slot so both sets of bytes survive.
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        std::fs::write(&path, "first-corrupt").unwrap();
        AgentState::load_from(&path);
        std::fs::write(&path, "second-corrupt").unwrap();
        AgentState::load_from(&path);

        std::fs::write(&path, "third-corrupt").unwrap();
        AgentState::load_from(&path);

        let b0 = tmp.path().join("state.json.bak");
        let b1 = tmp.path().join("state.json.bak.1");
        let b2 = tmp.path().join("state.json.bak.2");
        assert_eq!(std::fs::read_to_string(&b0).unwrap(), "first-corrupt");
        assert_eq!(std::fs::read_to_string(&b1).unwrap(), "second-corrupt");
        assert_eq!(std::fs::read_to_string(&b2).unwrap(), "third-corrupt");
    }

    #[test]
    fn save_writes_version_and_leaves_no_temp_file() {
        // A save round-trips, stamps the current schema version into the file,
        // and leaves no partial/temp artifact behind (atomic write, #2366).
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        let mut state = AgentState::default();
        state
            .sessions
            .insert("s".to_string(), make_session("local", Some("/tmp/s.sock")));
        state.save_to(&path);

        let raw = std::fs::read_to_string(&path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(json["version"], CURRENT_STATE_VERSION);

        let loaded = AgentState::load_from(&path);
        assert_eq!(loaded.version, CURRENT_STATE_VERSION);
        assert_eq!(loaded.sessions.len(), 1);

        // No leftover temp/partial files — only state.json remains.
        let names: Vec<String> = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["state.json".to_string()], "got {names:?}");
    }

    #[test]
    fn legacy_versionless_state_loads_as_version_zero_and_upgrades_on_save() {
        // A pre-versioning state.json (no `version` key) still loads: it reads
        // back as version 0 so a future migration hook (#2744) can spot it, and a
        // re-save transparently upgrades it to the current version.
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        std::fs::write(
            &path,
            r#"{
              "sessions": {
                "sess-1": {
                  "type_id": "shell",
                  "title": "Legacy",
                  "created_at": "2026-02-20T10:00:00Z",
                  "daemon_socket": "/tmp/legacy.sock",
                  "settings": {}
                }
              }
            }"#,
        )
        .unwrap();

        let loaded = AgentState::load_from(&path);
        assert_eq!(loaded.version, 0, "versionless file must read back as 0");
        assert_eq!(loaded.sessions.len(), 1);

        // Re-saving stamps the current version without losing sessions.
        loaded.save_to(&path);
        let reloaded = AgentState::load_from(&path);
        assert_eq!(reloaded.version, CURRENT_STATE_VERSION);
        assert_eq!(reloaded.sessions.len(), 1);
    }

    #[test]
    fn docker_session_round_trip() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        let mut state = AgentState::default();
        state.sessions.insert(
            "docker-1".to_string(),
            PersistedSession {
                type_id: "docker".to_string(),
                title: "Docker test".to_string(),
                created_at: "2026-02-20T10:00:00Z".to_string(),
                daemon_socket: Some("/tmp/docker.sock".to_string()),
                settings: json!({"image": "ubuntu:22.04", "shell": "/bin/bash"}),
                definition_id: None,
            },
        );
        state.save_to(&path);

        let loaded = AgentState::load_from(&path);
        assert_eq!(loaded.sessions.len(), 1);

        let s = &loaded.sessions["docker-1"];
        assert_eq!(s.type_id, "docker");
        assert_eq!(s.daemon_socket.as_deref(), Some("/tmp/docker.sock"));
        assert_eq!(s.settings["image"], "ubuntu:22.04");
    }

    #[test]
    fn definition_id_round_trips() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        let mut state = AgentState::default();
        state.sessions.insert(
            "sess-1".to_string(),
            PersistedSession {
                type_id: "shell".to_string(),
                title: "Build".to_string(),
                created_at: "2026-02-20T10:00:00Z".to_string(),
                daemon_socket: Some("/tmp/s.sock".to_string()),
                settings: json!({}),
                definition_id: Some("def-42".to_string()),
            },
        );
        state.save_to(&path);

        let loaded = AgentState::load_from(&path);
        assert_eq!(
            loaded.sessions["sess-1"].definition_id.as_deref(),
            Some("def-42")
        );
    }

    #[test]
    fn legacy_state_without_definition_id_loads() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        // Pre-existing state.json from an earlier agent version that did not
        // know about definition_id — must still load (default to None).
        std::fs::write(
            &path,
            r#"{
              "sessions": {
                "sess-1": {
                  "type_id": "shell",
                  "title": "Legacy",
                  "created_at": "2026-02-20T10:00:00Z",
                  "daemon_socket": "/tmp/legacy.sock",
                  "settings": {}
                }
              }
            }"#,
        )
        .unwrap();

        let loaded = AgentState::load_from(&path);
        assert_eq!(loaded.sessions.len(), 1);
        assert!(loaded.sessions["sess-1"].definition_id.is_none());
    }

    #[test]
    fn config_dir_returns_absolute_path_under_termihub_agent() {
        // Regression test for #764: on every supported platform (including
        // Windows) the agent's config directory must be an absolute path
        // rooted under the OS's user config location, not a relative
        // working-directory path.
        let dir = config_dir();
        assert!(
            dir.is_absolute(),
            "config_dir must be absolute, got {}",
            dir.display()
        );
        assert!(
            dir.ends_with("termihub-agent"),
            "config_dir must end with 'termihub-agent', got {}",
            dir.display()
        );
    }

    #[test]
    fn state_path_lives_inside_config_dir() {
        let path = AgentState::default_path();
        assert_eq!(
            path.file_name().and_then(|s| s.to_str()),
            Some("state.json")
        );
        assert!(
            path.is_absolute(),
            "state_path must be absolute, got {}",
            path.display()
        );
    }

    #[test]
    fn update_state_round_trips() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        let mut state = AgentState::default();
        state.update.last_check_time = Some("2026-07-10T12:00:00Z".to_string());
        state.update.pending_update = Some(PendingUpdate {
            version: "0.3.0".to_string(),
            binary_path: "/tmp/updates/termihub-agent-linux-x64".to_string(),
            staged_at: "2026-07-10T12:00:01Z".to_string(),
            expected_sha256: Some("a".repeat(64)),
            signature: Some("c2ln".to_string()),
            pinned_version: None,
        });
        state.save_to(&path);

        let loaded = AgentState::load_from(&path);
        assert_eq!(
            loaded.update.last_check_time.as_deref(),
            Some("2026-07-10T12:00:00Z")
        );
        let pending = loaded
            .update
            .pending_update
            .expect("pending update present");
        assert_eq!(pending.version, "0.3.0");
        assert_eq!(pending.binary_path, "/tmp/updates/termihub-agent-linux-x64");
        assert_eq!(pending.signature.as_deref(), Some("c2ln"));
    }

    #[test]
    fn deferred_update_request_round_trips_and_consumes() {
        // A deferred update requested via `agent.request_deferred_update` records
        // a PendingUpdate (version may be empty when only a path is supplied). It
        // must survive a restart and clear cleanly once consumed on apply.
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        let mut state = AgentState::default();
        state.update.pending_update = Some(PendingUpdate {
            version: String::new(),
            binary_path: "/opt/updates/termihub-agent".to_string(),
            staged_at: "2026-07-14T09:00:00Z".to_string(),
            expected_sha256: None,
            signature: None,
            pinned_version: None,
        });
        state.save_to(&path);

        // Survives a restart.
        let mut reloaded = AgentState::load_from(&path);
        let pending = reloaded
            .update
            .pending_update
            .clone()
            .expect("pending update present after reload");
        assert_eq!(pending.binary_path, "/opt/updates/termihub-agent");
        assert!(pending.version.is_empty());

        // Consuming it (apply) clears it and persists the cleared state.
        let taken = reloaded.update.pending_update.take();
        assert!(taken.is_some());
        reloaded.save_to(&path);
        let after = AgentState::load_from(&path);
        assert!(after.update.pending_update.is_none());
    }

    #[test]
    fn pending_update_without_expected_sha256_loads_as_none() {
        // A `pending_update` written by an agent that predates the AGT-004
        // digest field must still load — the missing field defaults to `None`
        // (which the apply path then treats as a fail-closed rejection).
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        std::fs::write(
            &path,
            r#"{
              "sessions": {},
              "update": {
                "pending_update": {
                  "version": "0.3.0",
                  "binary_path": "/opt/updates/termihub-agent",
                  "staged_at": "2026-07-14T09:00:00Z"
                }
              }
            }"#,
        )
        .unwrap();

        let loaded = AgentState::load_from(&path);
        let pending = loaded
            .update
            .pending_update
            .expect("legacy pending update present");
        assert_eq!(pending.binary_path, "/opt/updates/termihub-agent");
        assert_eq!(pending.expected_sha256, None);
        assert_eq!(pending.signature, None);
    }

    #[test]
    fn legacy_state_without_update_field_loads() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        // Pre-existing state.json from an agent version that predates #1355 —
        // must still load, defaulting `update` to an empty UpdateState.
        std::fs::write(
            &path,
            r#"{
              "sessions": {}
            }"#,
        )
        .unwrap();

        let loaded = AgentState::load_from(&path);
        assert!(loaded.sessions.is_empty());
        assert_eq!(loaded.update, UpdateState::default());
        assert!(loaded.update.last_check_time.is_none());
        assert!(loaded.update.pending_update.is_none());
    }

    /// A save that fails part-way (here: the parent directory is read-only, so a
    /// new temp file cannot be created) must leave the **previous** good
    /// `state.json` untouched — never a truncated or empty file. This is the
    /// whole point of an atomic write: a torn write must never lose the persisted
    /// session-recovery state. Regression test for #2366.
    #[cfg(unix)]
    #[test]
    fn failed_save_preserves_previous_state() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("cfg");
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("state.json");

        // Persist a good state first.
        let mut original = AgentState::default();
        original.sessions.insert(
            "keep".to_string(),
            make_session("local", Some("/tmp/keep.sock")),
        );
        original.save_to(&path);
        assert_eq!(AgentState::load_from(&path).sessions.len(), 1);

        // Make the parent directory read-only so the save cannot complete.
        let mut ro = std::fs::metadata(&dir).unwrap().permissions();
        ro.set_mode(0o500);
        std::fs::set_permissions(&dir, ro).unwrap();

        // Attempt to save a DIFFERENT state; the write must fail internally
        // without panicking and without clobbering the file on disk.
        let mut changed = AgentState::default();
        changed
            .sessions
            .insert("gone".to_string(), make_session("serial", None));
        changed.save_to(&path);

        // Restore write permission so we can read the file and so temp-dir
        // cleanup succeeds.
        let mut rw = std::fs::metadata(&dir).unwrap().permissions();
        rw.set_mode(0o700);
        std::fs::set_permissions(&dir, rw).unwrap();

        // The on-disk file must still hold the ORIGINAL state, intact.
        let recovered = AgentState::load_from(&path);
        assert_eq!(
            recovered.sessions.len(),
            1,
            "a failed save clobbered state.json — torn write lost data"
        );
        assert!(recovered.sessions.contains_key("keep"));
        assert!(!recovered.sessions.contains_key("gone"));
    }

    /// Two simulated workers concurrently inserting *different* sessions into
    /// the same shared `state.json` must both survive — the classic lost-update
    /// that `mutate_locked`'s locked read-modify-write exists to prevent
    /// (AGT-016). Without the lock + re-read, one worker's blind whole-struct
    /// save would clobber the other's session.
    #[test]
    fn concurrent_mutate_locked_never_loses_an_insert() {
        use std::sync::Arc;

        let tmp = TempDir::new().unwrap();
        let path = Arc::new(tmp.path().join("state.json"));
        AgentState::default().save_to(path.as_path());

        let iters = 40;
        let workers = 3;
        let handles: Vec<_> = (0..workers)
            .map(|w| {
                let path = Arc::clone(&path);
                std::thread::spawn(move || {
                    for i in 0..iters {
                        let key = format!("w{w}-{i}");
                        AgentState::mutate_locked(&path, |s| {
                            s.sessions
                                .insert(key.clone(), make_session("local", Some("/tmp/s.sock")));
                        });
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        let loaded = AgentState::load_from(path.as_path());
        assert_eq!(
            loaded.sessions.len(),
            workers * iters,
            "every worker's inserts must survive — a shortfall means a lost update"
        );
        for w in 0..workers {
            for i in 0..iters {
                assert!(
                    loaded.sessions.contains_key(&format!("w{w}-{i}")),
                    "missing session w{w}-{i} — lost update"
                );
            }
        }
    }

    /// A `mutate_locked` remove must delete only the targeted session and
    /// preserve the rest of the on-disk map (a peer worker's sessions), because
    /// it re-reads the current file rather than overwriting with a stale
    /// snapshot.
    #[test]
    fn mutate_locked_remove_preserves_other_sessions() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        let mut seeded = AgentState::default();
        seeded.sessions.insert(
            "keep".to_string(),
            make_session("local", Some("/tmp/k.sock")),
        );
        seeded
            .sessions
            .insert("drop".to_string(), make_session("serial", None));
        seeded.save_to(&path);

        let merged = AgentState::mutate_locked(&path, |s| {
            s.sessions.remove("drop");
        });

        assert!(merged.sessions.contains_key("keep"));
        assert!(!merged.sessions.contains_key("drop"));
        let loaded = AgentState::load_from(&path);
        assert_eq!(loaded.sessions.len(), 1);
        assert!(loaded.sessions.contains_key("keep"));
    }

    #[test]
    fn unknown_top_level_fields_round_trip_via_flatten() {
        // PER-010: a top-level key written by a newer app version that this
        // struct does not model must survive a load→save round-trip instead of
        // being dropped — otherwise a downgrade/rollback erases whatever the
        // newer version persisted into state.json. Without the
        // `#[serde(flatten)] extra` catch-all this assertion fails (the key
        // vanishes on re-serialize), which is what makes it a guard.
        let json = json!({
            "version": 1,
            "sessions": {},
            "update": {},
            "future_field": { "a": 1, "b": [true, false] },
            "another_new_key": "keep-me",
        });

        let state: AgentState = serde_json::from_value(json.clone()).unwrap();
        let round_tripped = serde_json::to_value(&state).unwrap();
        assert_eq!(
            round_tripped.get("future_field"),
            json.get("future_field"),
            "unknown top-level key was dropped on save — a downgrade would lose it",
        );
        assert_eq!(
            round_tripped.get("another_new_key"),
            json.get("another_new_key"),
        );
        // Known fields still deserialize correctly alongside the catch-all.
        assert_eq!(state.version, 1);
        assert!(state.sessions.is_empty());
    }

    #[test]
    fn empty_extra_keeps_serialized_state_clean() {
        // An empty catch-all must not leak an `extra` key into state.json — a
        // normal state with no unknown fields serializes exactly as before.
        let json = serde_json::to_value(AgentState::default()).unwrap();
        assert!(json.get("extra").is_none(), "flatten leaked an `extra` key");
    }

    #[test]
    fn save_load_preserves_unknown_top_level_field_from_newer_version() {
        // The real persistence path: a state.json written by a newer agent
        // carries a top-level key this version does not model. Loading and
        // re-saving (e.g. on a rollback/downgrade) must keep it verbatim rather
        // than erase it (PER-010). Regression test for the drop-unknown gap.
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        std::fs::write(
            &path,
            r#"{
              "version": 2,
              "sessions": {},
              "update": {},
              "future_feature": { "enabled": true, "threshold": 42 }
            }"#,
        )
        .unwrap();

        let loaded = AgentState::load_from(&path);
        loaded.save_to(&path);

        let raw = std::fs::read_to_string(&path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            json.get("future_feature"),
            Some(&json!({ "enabled": true, "threshold": 42 })),
            "a newer version's field was erased on rollback save — data loss",
        );
    }

    /// AGT-021: `state.json` holds the full connection settings JSON for every
    /// persisted session, so on a multi-user host it must never be world- or
    /// group-readable. After a save the file must be `0o600` (owner read/write
    /// only). Regression test — a save path that writes with the default umask
    /// (world-readable `0o644`) fails this.
    #[cfg(unix)]
    #[test]
    fn saved_state_is_owner_readable_only() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        let mut state = AgentState::default();
        state.sessions.insert(
            "sess-1".to_string(),
            make_session("ssh", Some("/tmp/s.sock")),
        );
        state.save_to(&path);

        let mode = std::fs::metadata(&path)
            .expect("state.json metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            mode, 0o600,
            "state.json must be owner-only (0o600), got {mode:o} — it holds \
             connection settings and must not be world/group readable"
        );
    }

    #[test]
    fn add_and_remove_session() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        let mut state = AgentState::default();
        state.sessions.insert(
            "sess-1".to_string(),
            make_session("local", Some("/tmp/s1.sock")),
        );
        state.save_to(&path);

        let loaded = AgentState::load_from(&path);
        assert_eq!(loaded.sessions.len(), 1);

        let mut state = loaded;
        state.sessions.remove("sess-1");
        state.save_to(&path);

        let loaded = AgentState::load_from(&path);
        assert!(loaded.sessions.is_empty());
    }

    // ── #2744: version gate, downgrade refusal, salvage ─────────────────────

    const NEWER_STATE: &str = r#"{
      "version": 99,
      "sessions": {
        "future-1": { "type_id": "shell", "title": "From the future",
                      "created_at": "2026-02-20T10:00:00Z", "settings": {} }
      },
      "futureKey": { "keep": true }
    }"#;

    #[test]
    fn newer_version_state_is_never_overwritten_by_save() {
        // A downgraded agent must not rewrite a state.json a newer agent wrote.
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        std::fs::write(&path, NEWER_STATE).unwrap();

        let mut state = AgentState::load_from(&path);
        state
            .sessions
            .insert("mine".to_string(), make_session("local", None));
        state.save_to(&path);

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            NEWER_STATE,
            "a newer-version state.json must be left byte-for-byte intact"
        );
    }

    #[test]
    fn newer_version_state_is_not_interpreted_on_load() {
        // A newer schema's sessions are not trusted (their shape may differ), and
        // the file is left in place rather than quarantined as "corrupt".
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        std::fs::write(&path, NEWER_STATE).unwrap();

        let state = AgentState::load_from(&path);
        assert!(state.sessions.is_empty());
        assert!(!tmp.path().join("state.json.bak").exists());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), NEWER_STATE);
    }

    #[test]
    fn mutate_locked_refuses_to_overwrite_newer_version() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        std::fs::write(&path, NEWER_STATE).unwrap();

        AgentState::mutate_locked(&path, |s| {
            s.sessions
                .insert("mine".to_string(), make_session("local", None));
        });

        assert_eq!(std::fs::read_to_string(&path).unwrap(), NEWER_STATE);
    }

    #[test]
    fn save_refuses_newer_file_written_after_load() {
        // A newer agent may write state.json between our load and our save; the
        // guard re-reads the file at save time.
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        let state = AgentState::load_from(&path);
        std::fs::write(&path, NEWER_STATE).unwrap();

        state.save_to(&path);

        assert_eq!(std::fs::read_to_string(&path).unwrap(), NEWER_STATE);
    }

    #[test]
    fn string_version_loads_as_current() {
        // The shared store convention writes `version` as a JSON string; a
        // `"1"` file must load, not be treated as corrupt.
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        std::fs::write(
            &path,
            r#"{"version":"1","sessions":{"s":{"type_id":"shell","title":"t",
                "created_at":"2026-02-20T10:00:00Z","settings":{}}}}"#,
        )
        .unwrap();

        let state = AgentState::load_from(&path);
        assert_eq!(state.sessions.len(), 1);
        assert!(!tmp.path().join("state.json.bak").exists());
    }

    #[test]
    fn one_malformed_session_is_salvaged_not_all_discarded() {
        // Valid JSON with one bad entry: the good sessions, the update record and
        // unknown keys survive; the original bytes are backed up first.
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        let original = r#"{
          "version": 1,
          "sessions": {
            "good": { "type_id": "shell", "title": "Good",
                      "created_at": "2026-02-20T10:00:00Z", "settings": {} },
            "bad": { "type_id": 42 }
          },
          "update": { "last_check_time": "2026-02-20T10:00:00Z" },
          "futureKey": [1, 2, 3]
        }"#;
        std::fs::write(&path, original).unwrap();

        let state = AgentState::load_from(&path);
        assert_eq!(state.sessions.len(), 1);
        assert!(state.sessions.contains_key("good"));
        assert_eq!(
            state.update.last_check_time.as_deref(),
            Some("2026-02-20T10:00:00Z")
        );
        assert_eq!(state.extra.get("futureKey"), Some(&json!([1, 2, 3])));

        let backups: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("state.json.bak")
            })
            .collect();
        assert_eq!(backups.len(), 1, "exactly one backup expected: {backups:?}");
        assert_eq!(std::fs::read_to_string(&backups[0]).unwrap(), original);

        // The salvaged state persists (the live file is rewritten cleanly).
        state.save_to(&path);
        let reloaded = AgentState::load_from(&path);
        assert!(reloaded.sessions.contains_key("good"));
    }

    #[test]
    fn corrupt_state_that_cannot_be_backed_up_is_never_overwritten() {
        // If the corrupt bytes cannot be copied aside, nothing may overwrite them.
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        std::fs::write(&path, "{ this is not json").unwrap();
        // Exhaust every shared `.bak[.N]` slot so the backup is impossible.
        for _ in 0..termihub_core::util::persist::MAX_CORRUPT_BACKUPS {
            termihub_core::util::persist::backup_corrupt(&path, b"x").unwrap();
        }

        let mut state = AgentState::load_from(&path);
        state
            .sessions
            .insert("mine".to_string(), make_session("local", None));
        state.save_to(&path);
        AgentState::mutate_locked(&path, |s| {
            s.sessions
                .insert("other".to_string(), make_session("local", None));
        });

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{ this is not json",
            "corrupt bytes with no backup must stay on disk"
        );
        // No backup slot was clobbered either.
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("state.json.bak")).unwrap(),
            "x"
        );
    }
}

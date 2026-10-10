//! Fixture addressing and skip-or-fail gating for the Rust integration tests
//! (#4338, audit findings MOCK2-001, TBE2-003 and TBE2-006).
//!
//! Every crate's integration tests reach the same `tests/docker` fixtures and
//! the same kinds of optional host dependencies (a Docker daemon, a local
//! `sshd`, a prebuilt agent binary). This module is the one place that decides,
//! for all of them:
//!
//! - **Where a fixture lives.** Ports are `base + test_port_offset` and
//!   container names are `<compose_project>-<service>`, both resolved from one
//!   [`FixtureEnv`] so they can never disagree. Precedence matches the shell
//!   resolver (`scripts/internal/dev-local-env.sh`) and the Python harness
//!   (`tests/system/termihub_harness/dev_local.py`): an explicit environment
//!   variable wins, then this checkout's `dev.local.json`, then the historical
//!   single-checkout default (offset `0`, project `termihub`). A plain
//!   `cargo test` in a parallel checkout therefore targets that checkout's
//!   containers, not checkout 0's.
//! - **Whether a missing dependency skips or fails.** Without the lane's
//!   require flag a test prints a visible `SKIPPED:` line and returns; with it
//!   (`TERMIHUB_REQUIRE_DOCKER=1`, `TERMIHUB_REQUIRE_LOCAL_SSHD=1`) the test
//!   panics, so a CI lane that provisions the dependency cannot go green by
//!   skipping.
//!
//! In a parallel `dev*/termiHub` tree a missing `dev.local.json` is an error,
//! not a silent fallback to checkout 0's ports (the Python harness's
//! `_guard_silent_collision`). `TERMIHUB_TEST_PORT_OFFSET` or
//! `TERMIHUB_ALLOW_DEFAULT_DEV_LOCAL=1` opts out.
//!
//! Test-only: compiled for this crate's own tests and, behind the
//! `fixture-test-support` feature, for other crates' tests. Only
//! `[dev-dependencies]` enable that feature. `core/tests/common` includes this
//! file directly, so every crate shares one copy of the logic.

// A test-support module: its job is to fail the calling test loudly, so
// panicking is the right way to report a broken fixture setup.
#![allow(
    clippy::panic,
    clippy::expect_used,
    reason = "test-support module: a panic is how a required fixture reports it is missing"
)]

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Shifts every fixture port for this checkout (`base + offset`).
pub const PORT_OFFSET_ENV: &str = "TERMIHUB_TEST_PORT_OFFSET";
/// Compose project that prefixes every fixture container name.
pub const PROJECT_ENV: &str = "TERMIHUB_TEST_PROJECT";
/// Opt-out: accept the single-checkout defaults even in a parallel tree.
pub const ALLOW_DEFAULT_ENV: &str = "TERMIHUB_ALLOW_DEFAULT_DEV_LOCAL";
/// Lane flag: a missing Docker daemon, image or fixture container fails.
pub const REQUIRE_DOCKER_ENV: &str = "TERMIHUB_REQUIRE_DOCKER";
/// Lane flag: a missing local `sshd`, `ssh` client or prebuilt
/// `termihub-agent` binary fails the headless agent-reconnect tests.
pub const REQUIRE_LOCAL_SSHD_ENV: &str = "TERMIHUB_REQUIRE_LOCAL_SSHD";
/// The per-checkout settings file at the workspace root.
pub const DEV_LOCAL_FILE: &str = "dev.local.json";
/// Compose project used when nothing else names one.
pub const DEFAULT_PROJECT: &str = "termihub";
/// Step between `dev<N>` checkouts' offsets (`docs/testing.md`).
pub const OFFSET_PER_SLOT: u32 = 1000;

/// Where this checkout's Docker fixtures live.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FixtureEnv {
    /// Added to every fixture's base host port.
    pub port_offset: u16,
    /// Prefix of every fixture container name.
    pub project: String,
}

impl Default for FixtureEnv {
    fn default() -> Self {
        Self {
            port_offset: 0,
            project: DEFAULT_PROJECT.to_string(),
        }
    }
}

impl FixtureEnv {
    /// Host port of a fixture whose single-checkout port is `base`.
    pub fn port(&self, base: u16) -> u16 {
        base.checked_add(self.port_offset).unwrap_or_else(|| {
            panic!(
                "fixture port {base} + test_port_offset {} overflows u16",
                self.port_offset
            )
        })
    }

    /// Name of the Compose fixture container for `service`.
    pub fn container(&self, service: &str) -> String {
        format!("{}-{service}", self.project)
    }
}

/// The workspace root (the directory that holds `dev.local.json`).
pub fn workspace_root() -> PathBuf {
    let core = Path::new(env!("CARGO_MANIFEST_DIR"));
    core.parent().unwrap_or(core).to_path_buf()
}

/// Resolve the fixture environment from `lookup` (an environment reader) and
/// the `dev.local.json` under `repo_root`.
///
/// An explicit, non-empty [`PORT_OFFSET_ENV`] / [`PROJECT_ENV`] wins; the file
/// is read only for a value the environment does not set. `Err` explains a
/// configuration that would silently collide with another checkout.
pub fn resolve<F>(lookup: F, repo_root: &Path) -> Result<FixtureEnv, String>
where
    F: Fn(&str) -> Option<String>,
{
    let env_offset = non_empty(lookup(PORT_OFFSET_ENV));
    let env_project = non_empty(lookup(PROJECT_ENV));
    let file = if env_offset.is_some() && env_project.is_some() {
        None
    } else {
        load_dev_local(&lookup, repo_root)?
    };

    let port_offset = match env_offset {
        Some(raw) => raw.trim().parse::<u16>().map_err(|_| {
            format!("{PORT_OFFSET_ENV}={raw:?} is not a port offset (an integer 0..=65535)")
        })?,
        None => file.as_ref().map_or(0, |f| f.port_offset),
    };
    let project = env_project
        .or_else(|| file.and_then(|f| f.project))
        .unwrap_or_else(|| DEFAULT_PROJECT.to_string());
    Ok(FixtureEnv {
        port_offset,
        project,
    })
}

/// This process's fixture environment (resolved once). Panics with the
/// collision explanation when the checkout's configuration is unsafe.
pub fn fixture_env() -> &'static FixtureEnv {
    static ENV: OnceLock<FixtureEnv> = OnceLock::new();
    ENV.get_or_init(|| {
        resolve(|name| std::env::var(name).ok(), &workspace_root())
            .unwrap_or_else(|e| panic!("{e}"))
    })
}

/// Host port of a fixture: `env_var` (e.g. `TERMIHUB_TEST_SSH_PASSWORD_PORT`)
/// when it is set to a port, else `base` shifted by this checkout's offset.
pub fn fixture_port(env_var: &str, base: u16) -> u16 {
    if let Some(port) = std::env::var(env_var)
        .ok()
        .and_then(|v| v.trim().parse().ok())
    {
        return port;
    }
    fixture_env().port(base)
}

/// Name of this checkout's Compose container for `service`.
pub fn fixture_container(service: &str) -> String {
    fixture_env().container(service)
}

/// What a fixture-gated test should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    /// The dependency is there: run the test body.
    Run,
    /// Missing and not required: skip with a visible `SKIPPED:` line.
    Skip,
    /// Missing but required by the lane: fail the test.
    Fail,
}

/// Decide the gate from availability and the lane's require flag.
pub fn gate(available: bool, required: bool) -> Gate {
    match (available, required) {
        (true, _) => Gate::Run,
        (false, false) => Gate::Skip,
        (false, true) => Gate::Fail,
    }
}

/// Interpret a flag value: `1`, `true`, `yes`, `on` (any case) are set;
/// anything else, including unset, is not.
pub fn parse_flag(value: Option<&str>) -> bool {
    matches!(
        value.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// Whether the environment variable `name` is set to a truthy flag value.
pub fn flag_set(name: &str) -> bool {
    parse_flag(std::env::var(name).ok().as_deref())
}

/// Gate a test on a dependency, reading `require_env` from the environment.
/// See [`require_with`].
pub fn require(available: bool, require_env: &str, what: &str, hint: &str) -> bool {
    require_with(available, flag_set(require_env), require_env, what, hint)
}

/// Gate a test on a dependency.
///
/// Returns `true` to run the test body. Prints `SKIPPED: <what> (<hint>)` and
/// returns `false` when the dependency is missing and not `required`. Panics
/// when it is missing and `required`, naming `require_env` as the reason.
pub fn require_with(
    available: bool,
    required: bool,
    require_env: &str,
    what: &str,
    hint: &str,
) -> bool {
    require_reported(
        available,
        required,
        format_args!("{what} ({hint})"),
        format_args!(
            "dependency unavailable: {what}, but {require_env} is set, so a \
             missing dependency is a failure here, not a skip ({hint})"
        ),
    )
}

/// Gate a test on a dependency with caller-worded messages: the one place the
/// skip-or-fail decision is acted on (#4544). Every gate helper in the Rust
/// test code ([`require_with`] and the per-crate `require_fixture`-style
/// wrappers) delegates here, so the `SKIPPED:` / `REQUIRED` prefixes CI and
/// humans look for are spelled once.
///
/// Returns `true` to run the test body. Prints `SKIPPED: <skip>` and returns
/// `false` when the dependency is missing and not `required`. Panics with
/// `REQUIRED <fail>` when it is missing and `required`.
pub fn require_reported(
    available: bool,
    required: bool,
    skip: std::fmt::Arguments<'_>,
    fail: std::fmt::Arguments<'_>,
) -> bool {
    match gate(available, required) {
        Gate::Run => true,
        Gate::Skip => {
            eprintln!("SKIPPED: {skip}");
            false
        }
        Gate::Fail => panic!("REQUIRED {fail}"),
    }
}

/// Report a dependency found missing during setup (no daemon, an image that
/// cannot be pulled, a container that will not start): print a `SKIPPED:` line,
/// or panic when `require_env` is set. The caller returns after it.
pub fn missing(require_env: &str, what: &str, hint: &str) {
    require(false, require_env, what, hint);
}

/// The `dev.local.json` keys the fixtures depend on.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DevLocal {
    port_offset: u16,
    project: Option<String>,
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.trim().is_empty())
}

/// Read `dev.local.json`. `Ok(None)` when it is absent or malformed and the
/// defaults are safe; `Err` when they would collide or the file contradicts
/// itself.
fn load_dev_local<F>(lookup: &F, repo_root: &Path) -> Result<Option<DevLocal>, String>
where
    F: Fn(&str) -> Option<String>,
{
    let path = repo_root.join(DEV_LOCAL_FILE);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return guard_silent_collision(lookup, repo_root, &path, "missing").map(|()| None);
    };
    let Ok(serde_json::Value::Object(data)) = serde_json::from_str::<serde_json::Value>(&text)
    else {
        return guard_silent_collision(lookup, repo_root, &path, "malformed").map(|()| None);
    };

    let port_offset = match data.get("test_port_offset") {
        None => 0,
        Some(value) => value
            .as_u64()
            .and_then(|n| u16::try_from(n).ok())
            .ok_or_else(|| {
                format!(
                    "{}: test_port_offset {value} is not an integer 0..=65535",
                    path.display()
                )
            })?,
    };
    let project = data
        .get("compose_project")
        .and_then(serde_json::Value::as_str)
        .filter(|p| !p.is_empty())
        .map(str::to_string);
    let dev_name = data.get("dev_name").and_then(serde_json::Value::as_str);
    check_consistency(dev_name, port_offset, project.as_deref(), repo_root)?;
    Ok(Some(DevLocal {
        port_offset,
        project,
    }))
}

/// `Err` when falling back to offset 0 / project `termihub` would silently
/// share checkout 0's fixtures.
fn guard_silent_collision<F>(
    lookup: &F,
    repo_root: &Path,
    path: &Path,
    reason: &str,
) -> Result<(), String>
where
    F: Fn(&str) -> Option<String>,
{
    if parse_flag(lookup(ALLOW_DEFAULT_ENV).as_deref())
        || non_empty(lookup(PORT_OFFSET_ENV)).is_some()
        || !sibling_checkouts_exist(repo_root)
    {
        return Ok(());
    }
    Err(format!(
        "{DEV_LOCAL_FILE} is {reason} at {}, but this checkout sits in a parallel \
         dev*/termiHub tree. Defaulting to test_port_offset 0 / project '{DEFAULT_PROJECT}' \
         would silently collide with checkout 0's ports and containers. Create the file \
         with a distinct dev_name and test_port_offset (see docs/testing.md -> 'Parallel \
         test isolation'), or set {PORT_OFFSET_ENV} / {ALLOW_DEFAULT_ENV} to opt out.",
        path.display()
    ))
}

/// The `N` of a `dev<N>` name.
fn slot_number(name: &str) -> Option<u32> {
    let digits = name.strip_prefix("dev")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// Whether `repo_root` is `…/dev<N>/<leaf>` with another `dev<M>/<leaf>`
/// checkout next to it.
fn sibling_checkouts_exist(repo_root: &Path) -> bool {
    let (Some(slot_dir), Some(leaf)) = (repo_root.parent(), repo_root.file_name()) else {
        return false;
    };
    if slot_dir
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(slot_number)
        .is_none()
    {
        return false;
    }
    let Some(tree) = slot_dir.parent() else {
        return false;
    };
    let Ok(entries) = std::fs::read_dir(tree) else {
        return false;
    };
    let me = repo_root
        .canonicalize()
        .unwrap_or_else(|_| repo_root.to_path_buf());
    entries.flatten().any(|entry| {
        let is_slot = entry.file_name().to_str().and_then(slot_number).is_some();
        let sibling = entry.path().join(leaf);
        is_slot
            && sibling.is_dir()
            && sibling.canonicalize().unwrap_or_else(|_| sibling.clone()) != me
    })
}

/// `Err` when a `dev<N>` checkout's offset or project names another slot.
fn check_consistency(
    dev_name: Option<&str>,
    port_offset: u16,
    project: Option<&str>,
    repo_root: &Path,
) -> Result<(), String> {
    let Some(slot) = dev_name.and_then(slot_number) else {
        return Ok(());
    };
    let expected = slot * OFFSET_PER_SLOT;
    if u32::from(port_offset) != expected {
        return Err(format!(
            "{DEV_LOCAL_FILE} in {} is inconsistent: dev_name 'dev{slot}' implies \
             test_port_offset {expected}, but it is {port_offset}, so this checkout would use \
             another checkout's test ports.",
            repo_root.display()
        ));
    }
    if let Some(named) = project
        .and_then(|p| p.strip_prefix("termihub-test-"))
        .and_then(|n| n.parse::<u32>().ok())
    {
        if named != slot {
            return Err(format!(
                "{DEV_LOCAL_FILE} in {} is inconsistent: dev_name 'dev{slot}' but \
                 compose_project names checkout {named}; set it to 'termihub-test-{slot}'.",
                repo_root.display()
            ));
        }
    }
    Ok(())
}

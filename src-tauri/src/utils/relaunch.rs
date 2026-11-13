//! Self-relaunch that keeps the instance's identity (#5647).
//!
//! "Restore and restart" (a backup restore) has to start termiHub again so the
//! staged stores load before anything reads them. Tauri's own
//! `AppHandle::request_restart` relaunches a binary inside a macOS `.app`
//! bundle through LaunchServices (`/usr/bin/open -n <bundle> --args …`), and
//! LaunchServices does not pass the environment on. A dev or test instance —
//! started by `scripts/dev.sh` or the system-test harness with
//! `TERMIHUB_CONFIG_DIR`, `TERMIHUB_LOG_DIR`, `TERMIHUB_DEV_NAME` and the test
//! bridge settings — then came back on the default profile and keychain
//! namespace, and the harness could not find it.
//!
//! This module relaunches the current executable **directly** on every
//! platform, with the full environment and the original arguments passed
//! explicitly:
//!
//! * The parent ([`spawn_relaunch`]) spawns the new process *before* it exits,
//!   so a failed spawn is reported to the user instead of leaving the app gone.
//!   The child gets [`RELAUNCH_AFTER_PID_ENV`] (the parent's pid) and
//!   [`RELAUNCH_IDENTITY_ENV`] (the names of the parent's `TERMIHUB_*`
//!   variables). Before spawning, the parent checks the command carries every
//!   one of its `TERMIHUB_*` variables unchanged.
//! * The child ([`prepare_relaunched_process`], first thing in `run()`)
//!   **refuses to start** when any variable named in the identity list is
//!   missing — a relaunch that lost its isolation must never fall back to the
//!   default profile or keychain namespace — and otherwise waits for the parent
//!   to exit, so the parent's single-instance and data-dir locks are released
//!   before the child takes them.
//!
//! The spawn goes through the [`Spawner`] seam and the wait through closures,
//! so both halves are unit-tested without starting a process.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Environment variable carrying the pid of the process that relaunched this
/// one. The child waits for that pid to exit before it starts up.
pub const RELAUNCH_AFTER_PID_ENV: &str = "TERMIHUB_RELAUNCH_AFTER_PID";

/// Environment variable listing (comma-separated) the names of every
/// `TERMIHUB_*` variable the relaunching process had. The child refuses to
/// start if any of them is missing.
pub const RELAUNCH_IDENTITY_ENV: &str = "TERMIHUB_RELAUNCH_IDENTITY";

/// Prefix of the variables that make up an instance's identity (profile, log
/// dir, dev name, test-bridge settings).
const IDENTITY_PREFIX: &str = "TERMIHUB_";

/// How long a relaunched process waits for its parent to exit before it starts
/// anyway. The parent only runs its teardown, so this is generous.
pub const PARENT_EXIT_TIMEOUT: Duration = Duration::from_secs(60);

/// How often the relaunched process checks whether its parent is gone.
const PARENT_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Exit code of a relaunched process that refused to start because its
/// identity did not survive the relaunch (`EX_CONFIG`).
pub const IDENTITY_LOST_EXIT_CODE: i32 = 78;

/// Set once a relaunch was spawned: the exit that follows must end the process
/// with code 0 instead of the restart exit code.
static RELAUNCH_PENDING: AtomicBool = AtomicBool::new(false);

/// Whether this process spawned its relaunch and is now exiting for it.
pub fn relaunch_pending() -> bool {
    RELAUNCH_PENDING.load(Ordering::SeqCst)
}

/// The command that starts the relaunched instance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelaunchCommand {
    /// The executable to start (the current binary).
    pub program: PathBuf,
    /// The arguments, without the program name.
    pub args: Vec<OsString>,
    /// The complete environment of the new process (it inherits nothing else).
    pub env: Vec<(OsString, OsString)>,
}

impl RelaunchCommand {
    /// Build the relaunch of `program` with `args` for the process `parent_pid`
    /// whose environment is `env`.
    ///
    /// The environment is passed on whole, minus any relaunch markers it already
    /// carried (a second restart), plus fresh ones: [`RELAUNCH_AFTER_PID_ENV`]
    /// and [`RELAUNCH_IDENTITY_ENV`].
    pub fn build(
        program: PathBuf,
        args: impl IntoIterator<Item = OsString>,
        env: impl IntoIterator<Item = (OsString, OsString)>,
        parent_pid: u32,
    ) -> Self {
        let mut env: Vec<(OsString, OsString)> = env
            .into_iter()
            .filter(|(name, _)| !is_relaunch_marker(name))
            .collect();
        let identity = identity_names(&env).join(",");
        env.push((
            RELAUNCH_AFTER_PID_ENV.into(),
            parent_pid.to_string().into(),
        ));
        env.push((RELAUNCH_IDENTITY_ENV.into(), identity.into()));
        Self {
            program,
            args: args.into_iter().collect(),
            env,
        }
    }

    /// The value this command sets for `name`, if any.
    pub fn env_value(&self, name: &OsStr) -> Option<&OsStr> {
        self.env
            .iter()
            .rev()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_os_str())
    }

    /// The process command: exactly [`Self::env`] as its environment, the
    /// arguments, stdin detached. Stdout and stderr are inherited so a log
    /// captured from the parent (the system-test harness) keeps receiving the
    /// relaunch's output. On unix the child gets its own process group, so a
    /// signal aimed at the exiting parent's group does not reach it.
    pub fn to_command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command
            .args(&self.args)
            .env_clear()
            .envs(self.env.iter().map(|(n, v)| (n, v)))
            .stdin(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        command
    }
}

/// Starts a [`RelaunchCommand`]. The seam the unit tests replace.
pub trait Spawner {
    /// Start the command without waiting for it.
    fn spawn(&self, command: &RelaunchCommand) -> io::Result<()>;
}

/// The real [`Spawner`]: starts the process and lets it run on its own.
pub struct OsSpawner;

impl Spawner for OsSpawner {
    fn spawn(&self, command: &RelaunchCommand) -> io::Result<()> {
        command.to_command().spawn().map(drop)
    }
}

/// Whether `name` is one of the relaunch markers this module sets.
fn is_relaunch_marker(name: &OsStr) -> bool {
    name == RELAUNCH_AFTER_PID_ENV || name == RELAUNCH_IDENTITY_ENV
}

/// The sorted names of the identity (`TERMIHUB_*`) variables in `env`, without
/// the relaunch markers.
fn identity_names(env: &[(OsString, OsString)]) -> Vec<String> {
    let mut names: Vec<String> = env
        .iter()
        .filter(|(name, _)| !is_relaunch_marker(name))
        .filter_map(|(name, _)| name.to_str())
        .filter(|name| name.starts_with(IDENTITY_PREFIX))
        .map(str::to_string)
        .collect();
    names.sort();
    names.dedup();
    names
}

/// The `TERMIHUB_*` variables of `parent_env` that `command` does not pass on
/// with the same value. Empty when the relaunch keeps the instance's identity.
pub fn identity_not_kept(
    parent_env: &[(OsString, OsString)],
    command: &RelaunchCommand,
) -> Vec<String> {
    parent_env
        .iter()
        .filter(|(name, _)| !is_relaunch_marker(name))
        .filter(|(name, _)| name.to_str().is_some_and(|n| n.starts_with(IDENTITY_PREFIX)))
        .filter(|(name, value)| command.env_value(name) != Some(value.as_os_str()))
        .map(|(name, _)| name.to_string_lossy().into_owned())
        .collect()
}

/// Spawn the relaunch of the current process through `spawner`.
///
/// Refuses (without spawning) when the command would not keep one of the
/// parent's `TERMIHUB_*` variables. On success the relaunch is marked pending:
/// the caller must now exit the app (see [`relaunch_pending`]).
pub fn spawn_relaunch(
    spawner: &dyn Spawner,
    program: PathBuf,
    args: impl IntoIterator<Item = OsString>,
    parent_env: Vec<(OsString, OsString)>,
    parent_pid: u32,
) -> io::Result<()> {
    let command = RelaunchCommand::build(program, args, parent_env.clone(), parent_pid);
    let lost = identity_not_kept(&parent_env, &command);
    if !lost.is_empty() {
        return Err(io::Error::other(format!(
            "the relaunch would not keep {}",
            lost.join(", ")
        )));
    }
    spawner.spawn(&command)?;
    RELAUNCH_PENDING.store(true, Ordering::SeqCst);
    Ok(())
}

/// What a starting process must do about a relaunch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelaunchStartup {
    /// Not a relaunch: start normally.
    NotRelaunched,
    /// A relaunch with its identity intact: wait for `parent_pid`, then start.
    WaitForParent {
        /// The pid of the process that relaunched this one.
        parent_pid: u32,
    },
    /// A relaunch that lost these identity variables: refuse to start.
    IdentityLost {
        /// The names of the missing variables.
        missing: Vec<String>,
    },
}

/// Decide what a starting process does, reading its environment via `var`.
///
/// A process with no [`RELAUNCH_AFTER_PID_ENV`] is not a relaunch. Otherwise
/// every name listed in [`RELAUNCH_IDENTITY_ENV`] must be set; a missing one
/// means the relaunch lost the instance's isolation. An unparseable pid skips
/// the wait but still checks the identity.
pub fn classify_startup(var: impl Fn(&str) -> Option<OsString>) -> RelaunchStartup {
    let Some(pid) = var(RELAUNCH_AFTER_PID_ENV) else {
        return RelaunchStartup::NotRelaunched;
    };
    let identity = var(RELAUNCH_IDENTITY_ENV).unwrap_or_default();
    let missing: Vec<String> = identity
        .to_string_lossy()
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .filter(|name| var(name).is_none())
        .map(str::to_string)
        .collect();
    if !missing.is_empty() {
        return RelaunchStartup::IdentityLost { missing };
    }
    match pid.to_str().and_then(|p| p.trim().parse::<u32>().ok()) {
        Some(parent_pid) => RelaunchStartup::WaitForParent { parent_pid },
        None => RelaunchStartup::NotRelaunched,
    }
}

/// Wait until `is_alive` reports the parent gone, polling every `poll` via
/// `sleep`, for at most `timeout` (measured by `now`). Returns whether the
/// parent exited in time.
pub fn wait_for_parent_exit(
    mut is_alive: impl FnMut() -> bool,
    timeout: Duration,
    poll: Duration,
    mut now: impl FnMut() -> Instant,
    mut sleep: impl FnMut(Duration),
) -> bool {
    let deadline = now() + timeout;
    loop {
        if !is_alive() {
            return true;
        }
        if now() >= deadline {
            return false;
        }
        sleep(poll);
    }
}

/// Whether the process `pid` still exists.
#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 performs only the existence and permission check; it
    // sends nothing and touches no memory.
    let rc = unsafe { libc::kill(pid, 0) };
    rc == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Whether the process `pid` still exists.
#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };
    // SAFETY: plain Win32 calls on a handle this function owns and closes.
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return false;
        }
        let alive = WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
        CloseHandle(handle);
        alive
    }
}

/// Run first thing in `run()`: act on a relaunch marker in this process's
/// environment.
///
/// Not a relaunch: nothing happens. A relaunch that lost its identity prints
/// why and exits with [`IDENTITY_LOST_EXIT_CODE`] — it never reaches a profile
/// or keychain. Otherwise the markers are removed from the environment (so the
/// app's child processes do not inherit them) and the process waits for its
/// parent to exit. Runs before any thread is started or log is open.
pub fn prepare_relaunched_process() {
    match classify_startup(|name| std::env::var_os(name)) {
        RelaunchStartup::NotRelaunched => {}
        RelaunchStartup::IdentityLost { missing } => {
            eprintln!(
                "termiHub: refusing to start: this relaunch lost {} (#5647)",
                missing.join(", ")
            );
            std::process::exit(IDENTITY_LOST_EXIT_CODE);
        }
        RelaunchStartup::WaitForParent { parent_pid } => {
            std::env::remove_var(RELAUNCH_AFTER_PID_ENV);
            std::env::remove_var(RELAUNCH_IDENTITY_ENV);
            let exited = wait_for_parent_exit(
                || process_alive(parent_pid),
                PARENT_EXIT_TIMEOUT,
                PARENT_POLL_INTERVAL,
                Instant::now,
                std::thread::sleep,
            );
            if !exited {
                eprintln!(
                    "termiHub: the previous instance (pid {parent_pid}) did not exit in time; \
                     starting anyway"
                );
            }
        }
    }
    // An unparseable pid still had its markers checked; drop them either way.
    if std::env::var_os(RELAUNCH_AFTER_PID_ENV).is_some() {
        std::env::remove_var(RELAUNCH_AFTER_PID_ENV);
        std::env::remove_var(RELAUNCH_IDENTITY_ENV);
    }
}

/// Relaunch the running app with its environment and arguments, then exit it.
///
/// Spawns the relaunch first (see [`spawn_relaunch`]); only when that worked
/// does it ask the app to exit, with Tauri's restart exit code so no window can
/// veto it. The `RunEvent::Exit` handler then ends the process with code 0
/// (see [`relaunch_pending`]). A failed spawn is returned and the app keeps
/// running.
pub fn relaunch_app(app: &tauri::AppHandle, spawner: &dyn Spawner) -> io::Result<()> {
    let env = app.env();
    let program = tauri::process::current_binary(&env)?;
    let args = env.args_os.iter().skip(1).cloned().collect::<Vec<_>>();
    spawn_relaunch(
        spawner,
        program,
        args,
        std::env::vars_os().collect(),
        std::process::id(),
    )?;
    app.exit(tauri::RESTART_EXIT_CODE);
    Ok(())
}

#[cfg(test)]
#[path = "relaunch_tests.rs"]
mod tests;

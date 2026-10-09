//! The per-runner watchdog (#4184): hang detection by ping/pong and, where the
//! OS has no hard memory limit (macOS), a resident-size poll.
//!
//! * **Hang:** a `Ping` every [`WatchdogConfig::ping_interval`]; when one stays
//!   unanswered for [`WatchdogConfig::hang_timeout`] the runner is "not
//!   responding" and is killed (counted as a crash). The runner answers pings
//!   on the thread that runs every plugin call, so a plugin stuck in
//!   `write_input` / `resize` / `close` stops the pongs. (The runner's reader
//!   thread answers bridge traffic itself but queues pings to that request
//!   thread on purpose, #4183.) A request with its own deadline
//!   (`CreateSession`, 30 s: a plugin may connect to a device first; a bridge
//!   request, the policy's connect timeout) suspends the verdict until it
//!   completes.
//! * **Memory:** with [`WatchdogConfig::rss_limit`] set, the runner's resident
//!   size is polled every [`WatchdogConfig::rss_poll_interval`] and the runner
//!   is killed past it (out of memory).
//!
//! The watchdog holds only a weak reference and ends with its runner.

use std::sync::atomic::Ordering;
use std::sync::Weak;
use std::time::{Duration, Instant};

use termihub_plugin_runner::ipc::{Heartbeat, Message};

use super::client::{SandboxedPlugin, EXIT_TIMEOUT};
use super::exit::RunnerExitCause;
use super::peer::Shared;

/// Default interval between pings.
pub const DEFAULT_PING_INTERVAL: Duration = Duration::from_secs(5);
/// Default time a ping may stay unanswered before the runner is killed.
pub const DEFAULT_HANG_TIMEOUT: Duration = Duration::from_secs(10);
/// Default interval between resident-size polls.
pub const DEFAULT_RSS_POLL_INTERVAL: Duration = Duration::from_secs(1);
/// Default resident-size limit: 1 GiB on macOS (no hard per-process limit
/// there), none elsewhere (`RLIMIT_AS` binds on Linux).
pub const DEFAULT_RSS_LIMIT: Option<u64> = if cfg!(target_os = "macos") {
    Some(1024 * 1024 * 1024)
} else {
    None
};

/// Shortest and longest watchdog tick.
const MIN_TICK: Duration = Duration::from_millis(5);
const MAX_TICK: Duration = Duration::from_secs(1);

/// What the watchdog checks and how often.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatchdogConfig {
    /// How often the host pings the runner.
    pub ping_interval: Duration,
    /// How long a ping may stay unanswered.
    pub hang_timeout: Duration,
    /// Resident-size limit in bytes; `None` disables the poll.
    pub rss_limit: Option<u64>,
    /// How often the resident size is polled.
    pub rss_poll_interval: Duration,
}

impl Default for WatchdogConfig {
    fn default() -> Self {
        Self {
            ping_interval: DEFAULT_PING_INTERVAL,
            hang_timeout: DEFAULT_HANG_TIMEOUT,
            rss_limit: DEFAULT_RSS_LIMIT,
            rss_poll_interval: DEFAULT_RSS_POLL_INTERVAL,
        }
    }
}

impl WatchdogConfig {
    fn tick(&self) -> Duration {
        let mut tick = self.ping_interval.min(self.hang_timeout / 4);
        if self.rss_limit.is_some() {
            tick = tick.min(self.rss_poll_interval);
        }
        (tick / 2).clamp(MIN_TICK, MAX_TICK)
    }
}

/// What a heartbeat check decided.
#[derive(Debug, PartialEq, Eq)]
enum Beat {
    /// Send a ping with this nonce.
    Ping(u64),
    /// The outstanding ping is overdue: the runner hangs.
    Hang,
    /// Nothing to do.
    Wait,
}

/// Start the watchdog thread for `plugin`.
/// `address_space_limit` is the runner's `RLIMIT_AS` (Linux) or its job
/// object's committed-memory limit (Windows), used to tell a hang from a
/// runner busy running out of memory.
///
/// A failed start is an `Err` (#4335): the caller must not let the plugin run
/// without hang detection and the memory kill.
pub(super) fn spawn(
    plugin: Weak<SandboxedPlugin>,
    config: WatchdogConfig,
    address_space_limit: Option<u64>,
    plugin_id: &str,
) -> std::io::Result<()> {
    super::threads::spawn(format!("plugin-runner-watchdog-{plugin_id}"), move || {
        run(&plugin, config, address_space_limit);
    })
}

/// The share of a memory limit above which a stalled runner counts as out of
/// memory rather than hung (#4239).
const MEMORY_PRESSURE_PERCENT: u64 = 85;

/// Whether `used` is close enough to `limit` to call it memory pressure.
fn near(used: u64, limit: u64) -> bool {
    used.saturating_mul(100) >= limit.saturating_mul(MEMORY_PRESSURE_PERCENT)
}

/// Why a runner that stopped answering pings is killed: out of memory when it
/// is close to a memory limit (it is stalled on allocation, or about to fail
/// one), else not responding.
fn hang_cause(
    pid: Option<u32>,
    config: &WatchdogConfig,
    address_space_limit: Option<u64>,
) -> RunnerExitCause {
    let pressure =
        pid.is_some_and(|pid| memory_pressure(pid, config.rss_limit, address_space_limit));
    if pressure {
        RunnerExitCause::OutOfMemory
    } else {
        RunnerExitCause::NotResponding
    }
}

/// Whether process `pid` is, by the host's own measurement, close to one of
/// its memory limits: `rss_limit` (the resident-size watchdog) or
/// `address_space_limit` (`RLIMIT_AS` on Linux, the job object's commit limit
/// on Windows). `false` when nothing can be measured (no limit, or the process
/// is gone).
pub(super) fn memory_pressure(
    pid: u32,
    rss_limit: Option<u64>,
    address_space_limit: Option<u64>,
) -> bool {
    let rss_pressure = rss_limit
        .zip(resident_bytes(pid))
        .is_some_and(|(limit, rss)| near(rss, limit));
    let address_space_pressure = address_space_limit
        .zip(address_space_bytes(pid))
        .is_some_and(|(limit, used)| near(used, limit));
    rss_pressure || address_space_pressure
}

fn run(plugin: &Weak<SandboxedPlugin>, config: WatchdogConfig, address_space_limit: Option<u64>) {
    let tick = config.tick();
    let mut next_ping = Instant::now() + config.ping_interval;
    let mut next_poll = Instant::now();
    loop {
        std::thread::sleep(tick);
        let Some(plugin) = plugin.upgrade() else {
            return;
        };
        if !plugin.is_alive() {
            return;
        }
        let now = Instant::now();
        match heartbeat(plugin.shared(), now, next_ping, config.hang_timeout) {
            Beat::Ping(nonce) => {
                next_ping = now + config.ping_interval;
                let _ = plugin.send(&Message::Ping(Heartbeat { nonce }));
            }
            Beat::Hang => {
                end(
                    &plugin,
                    hang_cause(plugin.pid(), &config, address_space_limit),
                );
                return;
            }
            Beat::Wait => {}
        }
        if let Some(limit) = config.rss_limit {
            if now >= next_poll {
                next_poll = now + config.rss_poll_interval;
                let over = plugin
                    .pid()
                    .and_then(resident_bytes)
                    .is_some_and(|rss| rss > limit);
                if over {
                    end(&plugin, RunnerExitCause::OutOfMemory);
                    return;
                }
            }
        }
    }
}

/// Kill the runner for `cause` and reap it here, so the cause is final even
/// if its reader thread is blocked delivering output.
fn end(plugin: &SandboxedPlugin, cause: RunnerExitCause) {
    plugin.shared().kill_for(cause);
    plugin.shared().reap(EXIT_TIMEOUT);
}

/// Advance the heartbeat: ping when due and none is outstanding, declare a
/// hang when the outstanding one is overdue and no call with its own deadline
/// is in flight.
fn heartbeat(shared: &Shared, now: Instant, next_ping: Instant, hang_timeout: Duration) -> Beat {
    // A `CreateSession` or a bridge request has its own deadline; the plugin
    // call behind it occupies the runner's request thread, which answers pings.
    let calls_in_flight =
        shared.calls_in_flight.load(Ordering::SeqCst) > 0 || shared.bridge.has_in_flight();
    let mut beat = shared.heartbeat.lock().unwrap_or_else(|e| e.into_inner());
    match beat.outstanding_since {
        // A call with its own deadline is running on the runner's request
        // thread: restart the clock, it answers after the call.
        Some(_) if calls_in_flight => {
            beat.outstanding_since = Some(now);
            Beat::Wait
        }
        Some(since) if now.saturating_duration_since(since) >= hang_timeout => Beat::Hang,
        Some(_) => Beat::Wait,
        None if now >= next_ping => {
            beat.last_sent += 1;
            beat.outstanding_since = Some(now);
            Beat::Ping(beat.last_sent)
        }
        None => Beat::Wait,
    }
}

/// The memory of process `pid` that its `address_space_bytes` limit caps, in
/// bytes: the address space (virtual size) under Linux's `RLIMIT_AS`, the
/// committed private memory under the Windows job object's per-process
/// memory limit (#4201, #4240). `None` elsewhere (macOS enforces no such
/// limit; the resident-size poll stands in there).
#[must_use]
fn address_space_bytes(pid: u32) -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let statm = std::fs::read_to_string(format!("/proc/{pid}/statm")).ok()?;
        let pages: u64 = statm.split_whitespace().next()?.parse().ok()?;
        // SAFETY: `sysconf` has no preconditions.
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        Some(pages.saturating_mul(u64::try_from(page).ok()?))
    }
    #[cfg(windows)]
    {
        committed_bytes(pid)
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = pid;
        None
    }
}

/// The private committed memory of process `pid` (its commit charge): what
/// `JOB_OBJECT_LIMIT_PROCESS_MEMORY` caps.
#[cfg(windows)]
fn committed_bytes(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };

    let size = u32::try_from(std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>()).ok()?;
    // SAFETY: opens the runner (a child of this process) for querying only;
    // the handle is closed below.
    let process =
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid) };
    if process.is_null() {
        return None;
    }
    // SAFETY: an all-zero `PROCESS_MEMORY_COUNTERS_EX` is a valid value.
    let mut counters: PROCESS_MEMORY_COUNTERS_EX = unsafe { std::mem::zeroed() };
    // SAFETY: `counters` is writable for `size` bytes; the EX struct starts
    // with the plain one, which is what the call's pointer type names.
    let ok = unsafe {
        K32GetProcessMemoryInfo(
            process,
            std::ptr::from_mut(&mut counters).cast::<PROCESS_MEMORY_COUNTERS>(),
            size,
        )
    };
    // SAFETY: closes the handle opened above, once.
    unsafe { CloseHandle(process) };
    (ok != 0).then(|| u64::try_from(counters.PrivateUsage).unwrap_or(u64::MAX))
}

/// The memory process `pid` uses, in bytes, where the platform can tell: the
/// resident size on Linux, the physical footprint (resident + compressed +
/// swapped) on macOS.
#[must_use]
pub(super) fn resident_bytes(pid: u32) -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        // `/proc/<pid>/statm`: size resident shared text lib data dt (pages).
        let statm = std::fs::read_to_string(format!("/proc/{pid}/statm")).ok()?;
        let pages: u64 = statm.split_whitespace().nth(1)?.parse().ok()?;
        // SAFETY: `sysconf` has no preconditions.
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        Some(pages.saturating_mul(u64::try_from(page).ok()?))
    }
    #[cfg(target_os = "macos")]
    {
        // The physical footprint, not `pti_resident_size`: under memory
        // pressure macOS compresses or swaps a process's pages, which drops
        // its resident size but not its footprint (#4239). The footprint is
        // what jetsam and Activity Monitor's "Memory" column account.
        let mut info = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
        // SAFETY: `info` is a writable `rusage_info_v2`, the struct the
        // `RUSAGE_INFO_V2` flavor fills.
        let rc = unsafe {
            libc::proc_pid_rusage(
                libc::c_int::try_from(pid).ok()?,
                libc::RUSAGE_INFO_V2,
                info.as_mut_ptr().cast::<libc::rusage_info_t>(),
            )
        };
        if rc != 0 {
            return None;
        }
        // SAFETY: the call succeeded, so the kernel filled the struct.
        Some(unsafe { info.assume_init() }.ri_phys_footprint)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_watchdog_that_cannot_start_is_an_error() {
        let _fail = crate::plugin::sandbox::threads::fail_spawns_named("plugin-runner-watchdog");
        let err = spawn(Weak::new(), WatchdogConfig::default(), None, "probe")
            .expect_err("an injected spawn failure surfaces");
        assert!(
            err.to_string().contains("plugin-runner-watchdog-probe"),
            "{err}"
        );
    }

    #[test]
    fn the_defaults_match_the_concept() {
        let config = WatchdogConfig::default();
        assert_eq!(config.ping_interval, Duration::from_secs(5));
        assert_eq!(config.hang_timeout, Duration::from_secs(10));
        if cfg!(target_os = "macos") {
            assert_eq!(config.rss_limit, Some(1 << 30));
        } else {
            assert_eq!(config.rss_limit, None);
        }
        assert!(config.tick() >= MIN_TICK && config.tick() <= MAX_TICK);
    }

    #[test]
    fn a_ping_is_sent_when_due_and_an_overdue_one_is_a_hang() {
        let shared = Shared::new(
            "probe".to_owned(),
            None,
            std::sync::Arc::new(crate::plugin::log_rate_limit::PluginLogLimiter::default()),
        );
        let hang = Duration::from_secs(10);
        let t0 = Instant::now();
        // Not due yet.
        assert_eq!(heartbeat(&shared, t0, t0 + hang, hang), Beat::Wait);
        assert_eq!(heartbeat(&shared, t0, t0, hang), Beat::Ping(1));
        // Outstanding, not overdue: no second ping.
        assert_eq!(heartbeat(&shared, t0 + hang / 2, t0, hang), Beat::Wait);
        assert_eq!(heartbeat(&shared, t0 + hang, t0, hang), Beat::Hang);
    }

    #[test]
    fn a_pong_clears_the_ping_and_a_call_in_flight_defers_the_verdict() {
        let shared = Shared::new(
            "probe".to_owned(),
            None,
            std::sync::Arc::new(crate::plugin::log_rate_limit::PluginLogLimiter::default()),
        );
        let hang = Duration::from_secs(10);
        let t0 = Instant::now();
        assert_eq!(heartbeat(&shared, t0, t0, hang), Beat::Ping(1));
        shared.calls_in_flight.store(1, Ordering::SeqCst);
        // A create is running: the clock restarts instead of a verdict.
        assert_eq!(heartbeat(&shared, t0 + hang * 2, t0, hang), Beat::Wait);
        shared.calls_in_flight.store(0, Ordering::SeqCst);
        assert_eq!(heartbeat(&shared, t0 + hang * 2, t0, hang), Beat::Wait);
        assert_eq!(heartbeat(&shared, t0 + hang * 3, t0, hang), Beat::Hang);
        // An answered ping clears it; the next one gets the next nonce.
        shared.heartbeat.lock().unwrap().outstanding_since = None;
        assert_eq!(heartbeat(&shared, t0 + hang * 3, t0, hang), Beat::Ping(2));
    }

    #[test]
    fn a_stalled_runner_near_its_memory_limit_is_out_of_memory() {
        assert!(near(86, 100));
        assert!(near(100, 100));
        assert!(!near(50, 100));
        let me = Some(std::process::id());
        let quiet = WatchdogConfig {
            rss_limit: None,
            ..WatchdogConfig::default()
        };
        // No limit, or far below one: a plain hang.
        assert_eq!(hang_cause(me, &quiet, None), RunnerExitCause::NotResponding);
        assert_eq!(
            hang_cause(None, &quiet, Some(1)),
            RunnerExitCause::NotResponding
        );
        assert_eq!(
            hang_cause(me, &quiet, Some(u64::MAX)),
            RunnerExitCause::NotResponding
        );
        // A limit this process already exceeds: out of memory.
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            let tight = WatchdogConfig {
                rss_limit: Some(1024),
                ..WatchdogConfig::default()
            };
            assert_eq!(hang_cause(me, &tight, None), RunnerExitCause::OutOfMemory);
        }
        #[cfg(target_os = "linux")]
        assert_eq!(
            hang_cause(me, &quiet, Some(1024)),
            RunnerExitCause::OutOfMemory
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn this_process_has_a_resident_size() {
        let rss = resident_bytes(std::process::id()).expect("readable");
        assert!(rss > 1024 * 1024, "{rss}");
    }
}

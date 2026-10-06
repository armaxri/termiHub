//! The per-runner watchdog (#4184): hang detection by ping/pong and, where the
//! OS has no hard memory limit (macOS), a resident-size poll.
//!
//! * **Hang:** a `Ping` every [`WatchdogConfig::ping_interval`]; when one stays
//!   unanswered for [`WatchdogConfig::hang_timeout`] the runner is "not
//!   responding" and is killed (counted as a crash). The runner answers pings
//!   on the thread that runs every plugin call, so a plugin stuck in
//!   `write_input` / `resize` / `close` stops the pongs. A request with its own
//!   deadline (`CreateSession`, 30 s: a plugin may connect to a device first)
//!   suspends the verdict until it completes.
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
pub(super) fn spawn(plugin: Weak<SandboxedPlugin>, config: WatchdogConfig, plugin_id: &str) {
    let _ = std::thread::Builder::new()
        .name(format!("plugin-runner-watchdog-{plugin_id}"))
        .spawn(move || run(&plugin, config));
}

fn run(plugin: &Weak<SandboxedPlugin>, config: WatchdogConfig) {
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
                end(&plugin, RunnerExitCause::NotResponding);
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
    let calls_in_flight = shared.calls_in_flight.load(Ordering::SeqCst) > 0;
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

/// The resident size of process `pid` in bytes, where the platform can tell.
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
        let mut info = std::mem::MaybeUninit::<libc::proc_taskinfo>::zeroed();
        let size = libc::c_int::try_from(std::mem::size_of::<libc::proc_taskinfo>()).ok()?;
        // SAFETY: `info` is writable for exactly `size` bytes; the kernel
        // fills at most that much and returns how many bytes it wrote.
        let written = unsafe {
            libc::proc_pidinfo(
                libc::c_int::try_from(pid).ok()?,
                libc::PROC_PIDTASKINFO,
                0,
                info.as_mut_ptr().cast(),
                size,
            )
        };
        if written != size {
            return None;
        }
        // SAFETY: the kernel filled the whole struct (checked above).
        Some(unsafe { info.assume_init() }.pti_resident_size)
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

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn this_process_has_a_resident_size() {
        let rss = resident_bytes(std::process::id()).expect("readable");
        assert!(rss > 1024 * 1024, "{rss}");
    }
}

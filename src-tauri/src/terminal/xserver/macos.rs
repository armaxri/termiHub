//! macOS XQuartz detection and guided, consent-based install (#1054).
//!
//! macOS can't embed an X server, so termiHub detects XQuartz and — only on an
//! explicit user action, never silently — guides its install: `brew install
//! --cask xquartz` when Homebrew is present, otherwise actionable guidance to
//! download it from xquartz.org (the hosted notarized `.pkg` path is a
//! follow-up). Detection is a pure check over injectable paths so it is
//! unit-testable on any CI host; the install runs off the async reactor.

use std::path::Path;
#[cfg(any(target_os = "macos", test))]
use std::time::Duration;

#[cfg(any(target_os = "macos", test))]
use tokio_util::sync::CancellationToken;

use super::types::XServerError;

/// How long to wait between readiness probes after launching XQuartz.
///
/// XQuartz can take a second or two to create its X socket / export `DISPLAY`
/// after `open -a XQuartz` returns, so an immediate re-probe often still finds
/// nothing. A short per-attempt interval keeps the loop responsive to both a
/// server coming up and a connect abort.
///
/// Gated to macOS (plus `test`, so the pure poll-loop tests run on every CI
/// host): only the macOS launch path consumes these, so an ungated definition
/// would be dead code on Linux/Windows.
#[cfg(any(target_os = "macos", test))]
const READINESS_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Total budget for the post-launch readiness wait (`~4s`).
///
/// Bounded so a genuinely dead launch still fails fast with the existing typed
/// `ServerUnreachable` error rather than hanging the connect path.
#[cfg(any(target_os = "macos", test))]
const READINESS_TOTAL_BUDGET: Duration = Duration::from_millis(4000);

/// Canonical XQuartz install locations on macOS.
///
/// `/opt/X11` is the runtime/framework tree; the `.app` is the launcher. Either
/// present means XQuartz is installed.
const XQUARTZ_PATHS: [&str; 2] = ["/opt/X11", "/Applications/Utilities/XQuartz.app"];

/// The Homebrew invocation that installs XQuartz. `brew` prompts for admin auth
/// itself, so the install stays consent-based.
const BREW_INSTALL_ARGS: [&str; 3] = ["install", "--cask", "xquartz"];

/// Whether XQuartz is installed at the canonical macOS locations.
pub(super) fn xquartz_installed() -> bool {
    any_path_exists(&XQUARTZ_PATHS.map(Path::new))
}

/// Whether any of `paths` exists. Pure over injected paths so detection is
/// unit-testable against temp directories (mock FS).
fn any_path_exists<P: AsRef<Path>>(paths: &[P]) -> bool {
    paths.iter().any(|p| p.as_ref().exists())
}

/// Best-effort launch of XQuartz when it is installed but idle. Errors are
/// ignored — detection afterwards decides whether a server actually came up.
///
/// Only this fn is macOS-gated (`open -a` is nonsensical elsewhere and its caller
/// is `#[cfg(target_os = "macos")]`); the rest of the module stays ungated so the
/// cross-platform `dependency_available` / install-command match arms compile.
#[cfg(target_os = "macos")]
pub(super) fn launch_xquartz() {
    let _ = std::process::Command::new("open")
        .args(["-a", "XQuartz"])
        .spawn();
}

/// Poll `is_ready` on a fixed `interval` until it succeeds, a `cancelled` abort
/// arrives, or `total_budget` is exhausted. Returns `true` iff the server became
/// ready within the budget.
///
/// Pure over its injected closures (`is_ready`, `cancelled`, `sleep`) so the
/// loop's timing, cancellation, and give-up behavior are unit-testable on any CI
/// host without launching XQuartz or actually sleeping. `sleep` is passed in for
/// the same reason — production wires `std::thread::sleep`, tests a no-op.
///
/// The first probe fires immediately (a server already up needs no wait); a
/// cancel is honored before each sleep so an in-flight connect abort short-cuts
/// the remaining budget.
///
/// Gated to macOS (plus `test`): the only production caller is the macOS
/// launch-and-wait path, so on Linux/Windows this is exercised solely by its own
/// unit tests.
#[cfg(any(target_os = "macos", test))]
fn poll_until_ready(
    interval: Duration,
    total_budget: Duration,
    is_ready: impl Fn() -> bool,
    cancelled: impl Fn() -> bool,
    mut sleep: impl FnMut(Duration),
) -> bool {
    let mut elapsed = Duration::ZERO;
    loop {
        // A connect abort takes precedence over anything else.
        if cancelled() {
            return false;
        }
        // The first probe fires before any sleep, so an already-up server is
        // detected immediately.
        if is_ready() {
            return true;
        }
        // Budget spent → give up so a dead launch still fails fast with the
        // existing typed error instead of hanging.
        if elapsed >= total_budget {
            return false;
        }
        // Clamp the final sleep so total waiting never overshoots the budget.
        let wait = interval.min(total_budget - elapsed);
        sleep(wait);
        elapsed += wait;
    }
}

/// Whether an SSH connect-abort token has been tripped, mapping the connect
/// path's optional [`CancellationToken`] into the boolean predicate
/// [`poll_until_ready`] consumes.
///
/// `None` is the status/probe path (the `x_server_ensure` command), which has no
/// connect to abort, so it never reports cancelled. `Some(token)` is the SSH
/// connect path (#1260): when the user aborts the connect the token trips and the
/// readiness wait short-cuts instead of running out its budget.
///
/// Gated to macOS (plus `test`): the only production caller is the macOS
/// launch-and-wait path.
#[cfg(any(target_os = "macos", test))]
fn token_cancelled(cancel: Option<&CancellationToken>) -> bool {
    cancel.is_some_and(CancellationToken::is_cancelled)
}

/// Launch XQuartz (best-effort) and wait a short, bounded time for it to become
/// ready before returning, so the connect path doesn't classify a
/// still-starting server as unreachable (#1088).
///
/// Called from the orchestrator's macOS path in place of a bare launch +
/// single immediate re-probe. Runs on the `spawn_blocking` thread the ensure
/// call already uses, so the `std::thread::sleep` between probes never blocks
/// the async reactor. `cancel` is the SSH connect-abort token threaded from the
/// connect path (#1260): when the user aborts the connect it short-cuts the wait
/// promptly instead of running out the readiness budget. `None` (the
/// status/probe path) is never cancelled. Readiness is re-checked via
/// `detect_local_x_server` each attempt.
#[cfg(target_os = "macos")]
pub(super) fn launch_xquartz_and_wait(cancel: Option<&CancellationToken>) {
    use termihub_core::backends::ssh::x11::detect_local_x_server;

    launch_xquartz();
    poll_until_ready(
        READINESS_POLL_INTERVAL,
        READINESS_TOTAL_BUDGET,
        || detect_local_x_server().is_some(),
        || token_cancelled(cancel),
        std::thread::sleep,
    );
}

/// Guided, consent-based XQuartz install.
///
/// Only ever called from the `x_server_install_dependency` command — i.e. after
/// an explicit user action, never on the silent connect path. Uses Homebrew when
/// available (`brew install --cask xquartz`, which prompts for admin auth
/// itself); otherwise returns the actionable download guidance the UI surfaces as
/// an "Open xquartz.org" action. Never installs anything silently.
pub(crate) async fn install_xquartz() -> Result<(), XServerError> {
    match decide_install_action(xquartz_installed(), super::binary_on_path("brew")) {
        InstallAction::AlreadyInstalled => Ok(()),
        InstallAction::InstallViaBrew => run_brew_install().await,
        // Homebrew absent → guide the user through installing it (the UI opens a
        // terminal with the installer), never a hosted/silent install (#1117).
        InstallAction::HomebrewRequired => Err(XServerError::homebrew_required()),
    }
}

/// What [`install_xquartz`] should do given the detected state. Pure over its
/// inputs so the branch is unit-testable without touching the real filesystem or
/// `PATH`, matching this module's injectable-detection style.
#[derive(Debug, PartialEq, Eq)]
enum InstallAction {
    /// XQuartz is already present — nothing to do.
    AlreadyInstalled,
    /// XQuartz missing but Homebrew present — install the cask automatically.
    InstallViaBrew,
    /// XQuartz missing and Homebrew absent — guide the user through installing
    /// Homebrew first (#1117), rather than hosting a `.pkg` or installing
    /// silently.
    HomebrewRequired,
}

/// Decide how to satisfy the XQuartz dependency from the two detected booleans.
fn decide_install_action(_xquartz_installed: bool, _brew_present: bool) -> InstallAction {
    todo!("decide_install_action — implemented in the follow-up commit")
}

/// Run `brew install --cask xquartz` off the async reactor, mapping a spawn
/// failure or non-zero exit to a typed, display-ready error.
async fn run_brew_install() -> Result<(), XServerError> {
    tokio::task::spawn_blocking(|| {
        let output = std::process::Command::new("brew")
            .args(BREW_INSTALL_ARGS)
            .output()
            .map_err(|e| XServerError::LaunchFailed {
                message: format!("Failed to run Homebrew: {e}"),
            })?;
        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = stderr
                .trim()
                .lines()
                .last()
                .unwrap_or("unknown error")
                .to_string();
            Err(XServerError::LaunchFailed {
                message: format!("Homebrew failed to install XQuartz: {detail}"),
            })
        }
    })
    .await
    .map_err(|e| XServerError::LaunchFailed {
        message: format!("XQuartz install task failed: {e}"),
    })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    // ── XQuartz readiness wait (#1088) ───────────────────────────────────────
    //
    // `poll_until_ready` is compiled for `test` on every platform (pure over its
    // injected closures), so these run on every CI host without launching XQuartz
    // or real sleeping. `sleep` is a spy that accumulates the requested durations.

    #[test]
    fn ready_on_first_probe_does_not_sleep() {
        // Server already up → the first (immediate) probe wins, no wait at all.
        let slept = Cell::new(Duration::ZERO);
        let ready = poll_until_ready(
            Duration::from_millis(250),
            Duration::from_millis(4000),
            || true,
            || false,
            |d| slept.set(slept.get() + d),
        );
        assert!(
            ready,
            "an already-ready server must be detected immediately"
        );
        assert_eq!(slept.get(), Duration::ZERO, "no sleep when ready up front");
    }

    #[test]
    fn ready_after_a_few_attempts_returns_true() {
        // XQuartz comes up on the 3rd probe (i.e. after 2 sleeps). This is the
        // core fix: the immediate re-probe used to miss this and fail.
        let attempts = Cell::new(0u32);
        let slept = Cell::new(Duration::ZERO);
        let ready = poll_until_ready(
            Duration::from_millis(250),
            Duration::from_millis(4000),
            || {
                let n = attempts.get() + 1;
                attempts.set(n);
                n >= 3
            },
            || false,
            |d| slept.set(slept.get() + d),
        );
        assert!(ready, "server that comes up mid-wait must be detected");
        assert_eq!(attempts.get(), 3, "should probe until ready, not just once");
        assert_eq!(
            slept.get(),
            Duration::from_millis(500),
            "two 250ms sleeps precede the successful third probe"
        );
    }

    #[test]
    fn never_ready_gives_up_within_budget() {
        // A dead launch: readiness never succeeds. The loop must stop once the
        // total budget is spent rather than spinning forever, and never sleep
        // past the budget.
        let attempts = Cell::new(0u32);
        let slept = Cell::new(Duration::ZERO);
        let ready = poll_until_ready(
            Duration::from_millis(250),
            Duration::from_millis(1000),
            || false,
            || false,
            |d| slept.set(slept.get() + d),
        );
        assert!(!ready, "a never-ready server must give up");
        assert!(
            slept.get() <= Duration::from_millis(1000),
            "must not sleep past the total budget, slept {:?}",
            slept.get()
        );
        // 1000ms budget / 250ms interval = 4 probes then give up.
        let _ = attempts;
    }

    #[test]
    fn cancellation_short_cuts_the_wait() {
        // An in-flight connect abort: `cancelled` flips true after the first
        // probe. The loop must bail immediately without exhausting the budget.
        let probes = Cell::new(0u32);
        let slept = Cell::new(Duration::ZERO);
        let ready = poll_until_ready(
            Duration::from_millis(250),
            Duration::from_millis(4000),
            || {
                probes.set(probes.get() + 1);
                false
            },
            || probes.get() >= 1,
            |d| slept.set(slept.get() + d),
        );
        assert!(!ready, "a cancelled wait must not report ready");
        assert!(
            slept.get() < Duration::from_millis(4000),
            "cancellation must short-cut the remaining budget, slept {:?}",
            slept.get()
        );
    }

    // ── Connect-abort token wiring (#1260) ───────────────────────────────────
    //
    // The readiness wait is driven by a `cancelled` predicate. `token_cancelled`
    // is the bridge from the SSH connect path's `CancellationToken` (threaded
    // through `ensure_x_server_for_session`) into that predicate, so an aborted
    // connect short-cuts the wait instead of running out the budget. These cover
    // the end-to-end wiring (the pure poll-loop cancellation path is already
    // covered above).

    #[test]
    fn token_cancelled_maps_absent_live_and_tripped() {
        // No token (the status/probe path with no connect abort) is never
        // cancelled; a live token isn't cancelled; a tripped one is.
        assert!(
            !token_cancelled(None),
            "the probe path (no token) must never report cancelled"
        );
        let token = tokio_util::sync::CancellationToken::new();
        assert!(
            !token_cancelled(Some(&token)),
            "a live connect token must not report cancelled"
        );
        token.cancel();
        assert!(
            token_cancelled(Some(&token)),
            "a tripped connect token must report cancelled"
        );
    }

    #[test]
    fn readiness_wait_bails_on_tripped_token() {
        // End-to-end wiring: a connect-abort token threaded into the readiness
        // wait short-cuts it before any sleep, rather than running out the
        // ~4s budget while the aborted connect waits.
        let token = tokio_util::sync::CancellationToken::new();
        token.cancel();
        let cancel = Some(&token);
        let probes = Cell::new(0u32);
        let slept = Cell::new(Duration::ZERO);
        let ready = poll_until_ready(
            READINESS_POLL_INTERVAL,
            READINESS_TOTAL_BUDGET,
            || {
                probes.set(probes.get() + 1);
                false
            },
            || token_cancelled(cancel),
            |d| slept.set(slept.get() + d),
        );
        assert!(
            !ready,
            "an aborted connect must not report the server ready"
        );
        assert_eq!(
            slept.get(),
            Duration::ZERO,
            "an already-tripped token must bail before any sleep"
        );
        assert_eq!(
            probes.get(),
            0,
            "cancellation is honored before the first readiness probe"
        );
    }

    #[test]
    fn final_attempt_does_not_overshoot_budget() {
        // With an interval that doesn't divide the budget evenly, the last sleep
        // is clamped so total sleep never exceeds the budget.
        let slept = Cell::new(Duration::ZERO);
        poll_until_ready(
            Duration::from_millis(300),
            Duration::from_millis(500),
            || false,
            || false,
            |d| slept.set(slept.get() + d),
        );
        assert!(
            slept.get() <= Duration::from_millis(500),
            "clamped final sleep must not exceed budget, slept {:?}",
            slept.get()
        );
    }

    #[test]
    fn readiness_constants_are_sane() {
        assert!(READINESS_POLL_INTERVAL <= READINESS_TOTAL_BUDGET);
        assert!(READINESS_POLL_INTERVAL > Duration::ZERO);
        // Bounded to a few seconds so a dead launch fails fast (issue #1088).
        assert!(READINESS_TOTAL_BUDGET <= Duration::from_secs(5));
    }

    #[test]
    fn detects_when_a_canonical_path_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let present = tmp.path().join("opt-x11");
        std::fs::create_dir(&present).unwrap();
        let absent = tmp.path().join("nope");
        assert!(any_path_exists(&[present.as_path(), absent.as_path()]));
        assert!(any_path_exists(&[absent.as_path(), present.as_path()]));
    }

    #[test]
    fn not_detected_when_no_path_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("nope-a");
        let b = tmp.path().join("nope-b");
        assert!(!any_path_exists(&[a.as_path(), b.as_path()]));
    }

    #[test]
    fn xquartz_paths_are_the_documented_locations() {
        assert!(XQUARTZ_PATHS.contains(&"/opt/X11"));
        assert!(XQUARTZ_PATHS.contains(&"/Applications/Utilities/XQuartz.app"));
    }

    #[test]
    fn brew_install_args_target_the_xquartz_cask() {
        assert_eq!(BREW_INSTALL_ARGS, ["install", "--cask", "xquartz"]);
    }

    // ── Install decision (#1117) ─────────────────────────────────────────────
    //
    // `decide_install_action` is pure over its two detected booleans, so the
    // brew-absent → guided-Homebrew branch is unit-testable on any CI host
    // without a real XQuartz / Homebrew install.

    #[test]
    fn already_installed_short_circuits_regardless_of_brew() {
        assert_eq!(decide_install_action(true, true), InstallAction::AlreadyInstalled);
        assert_eq!(decide_install_action(true, false), InstallAction::AlreadyInstalled);
    }

    #[test]
    fn missing_xquartz_with_brew_installs_via_brew() {
        assert_eq!(decide_install_action(false, true), InstallAction::InstallViaBrew);
    }

    #[test]
    fn missing_xquartz_without_brew_requires_homebrew_first() {
        // The core #1117 change: no Homebrew → guide its install rather than the
        // old dead-end manual-download error.
        assert_eq!(decide_install_action(false, false), InstallAction::HomebrewRequired);
    }
}

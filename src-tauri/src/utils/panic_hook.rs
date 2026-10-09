//! Durable panic reporting (OBS-002).
//!
//! A bundled desktop app has nowhere for a panic's stderr message to go, and the
//! process unwinds without leaving anything in the durable file log — so the one
//! event a field post-mortem most needs, the crash, is the one that records
//! nothing. This module installs a `std::panic::set_hook` that routes the panic
//! payload, its source location, and a captured backtrace through the `tracing`
//! pipeline *before* the default hook runs, so the write lands in the ring buffer
//! and (synchronously) in `termihub.log` before the process dies.
//!
//! It also writes a small, redacted crash report into the bounded local
//! `crash-reports/` directory next to the log (OBS-010), which the next start
//! offers to show or export. Nothing is ever sent over the network.
//!
//! The hook chains to the previously-installed hook, so the normal stderr
//! behaviour (and any test harness hook) is preserved.

use std::path::PathBuf;
use std::time::SystemTime;

use termihub_core::diagnostics::crash_report::{self, CrashDetails};
use termihub_core::diagnostics::redact::Redactor;

/// The tracing target panics are logged under. Kept as a termiHub-crate target so
/// the default filter keeps it at all levels and the durable file sink (INFO+)
/// records it.
const PANIC_TARGET: &str = "termihub_lib::panic";

/// Format a panic into a single durable log message.
///
/// Split out from the hook so the formatting is unit-testable without having to
/// construct a real `PanicHookInfo` (which cannot be built outside an actual
/// panic). `backtrace` is rendered as-is; an empty/disabled backtrace is omitted.
fn format_panic(message: &str, location: Option<&str>, backtrace: &str) -> String {
    let location = location.unwrap_or("unknown location");
    let mut out = format!("panic at {location}: {message}");
    let backtrace = backtrace.trim();
    if !backtrace.is_empty()
        && backtrace != "disabled backtrace"
        && backtrace != "unsupported backtrace"
    {
        out.push_str("\nbacktrace:\n");
        out.push_str(backtrace);
    }
    out
}

/// The app name recorded in desktop crash reports.
const APP_NAME: &str = "termiHub desktop";

/// Install the durable panic hook.
///
/// Must be called *after* the `tracing` subscriber is initialized, so the emitted
/// event reaches the file sink. Chains to the previously-installed hook.
///
/// `crash_dir` is where crash reports are written (`None` → log only). Startup
/// pruning of that directory runs on a background thread so it can never delay
/// the app's start.
pub fn install(crash_dir: Option<PathBuf>) {
    let redactor = Redactor::for_current_environment();
    if let Some(dir) = crash_dir.clone() {
        let warm = redactor.clone();
        let _ = std::thread::Builder::new()
            .name("crash-report-prune".into())
            .spawn(move || {
                let _ = crash_report::prune(
                    &dir,
                    crash_report::MAX_REPORTS,
                    crash_report::MAX_REPORT_AGE,
                    SystemTime::now(),
                );
                // Compile the redaction patterns now, not inside a panic.
                let _ = warm.redact("warm-up");
            });
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Payload, location and a force-captured backtrace. Release builds keep
        // their symbol table (`strip = "debuginfo"`, #4316), so the backtrace
        // names functions in shipped builds too; no profile keeps DWARF, so it
        // carries no source lines. See `CrashDetails::capture`.
        let details =
            CrashDetails::capture(info, APP_NAME, env!("CARGO_PKG_VERSION"), env!("GIT_HASH"));

        tracing::error!(
            target: PANIC_TARGET,
            "{}",
            format_panic(
                &details.message,
                details.location.as_deref(),
                &details.backtrace
            )
        );

        if let Some(dir) = &crash_dir {
            match crash_report::write_report(dir, &details, SystemTime::now(), &redactor) {
                Ok(path) => tracing::error!(
                    target: PANIC_TARGET,
                    "crash report written to {}",
                    path.display()
                ),
                Err(e) => tracing::warn!(target: PANIC_TARGET, "could not write crash report: {e}"),
            }
        }

        // Preserve the default (or test-harness) behaviour: stderr print / abort.
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_message_with_location() {
        let out = format_panic("something broke", Some("src/lib.rs:42:9"), "");
        assert_eq!(out, "panic at src/lib.rs:42:9: something broke");
    }

    #[test]
    fn falls_back_when_location_is_missing() {
        let out = format_panic("boom", None, "");
        assert_eq!(out, "panic at unknown location: boom");
    }

    #[test]
    fn appends_a_real_backtrace() {
        let out = format_panic("boom", Some("a:1:1"), "0: frame_one\n1: frame_two");
        assert!(out.contains("panic at a:1:1: boom"));
        assert!(out.contains("backtrace:\n0: frame_one"));
        assert!(out.contains("1: frame_two"));
    }

    #[test]
    fn omits_a_disabled_or_empty_backtrace() {
        assert!(!format_panic("boom", Some("a:1:1"), "disabled backtrace").contains("backtrace:"));
        assert!(!format_panic("boom", Some("a:1:1"), "   ").contains("backtrace:"));
    }

    #[test]
    fn install_chains_to_the_previous_hook_and_writes_a_crash_report() {
        // Installing must not blow up and must leave a working hook in place. We
        // cannot easily assert the tracing side without a global subscriber, but
        // we can prove the hook is installed, chains, and leaves a redacted
        // crash report in the given directory.
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(crash_report::CRASH_DIR_NAME);
        install(Some(dir.clone()));
        let result =
            std::panic::catch_unwind(|| panic!("hook self-test password=hunter2 10.9.8.7"));
        assert!(result.is_err());
        // Restore the default hook so later panicking tests do not write here.
        let _ = std::panic::take_hook();

        let reports = crash_report::list_reports(&dir);
        let report = reports
            .iter()
            .map(|r| std::fs::read_to_string(&r.path).unwrap())
            .find(|t| t.contains("hook self-test"))
            .expect("a crash report for the self-test panic");
        assert!(report.contains(APP_NAME));
        assert!(report.contains(env!("CARGO_PKG_VERSION")));
        assert!(!report.contains("hunter2"));
        assert!(!report.contains("10.9.8.7"));
    }
}

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

use std::backtrace::Backtrace;
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
        // Extract a human-readable payload. Rust panics carry either `&str`
        // (from `panic!("literal")`) or `String` (from `panic!("{}", x)`);
        // anything else is opaque.
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "Box<dyn Any>".to_string());

        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));

        // `force_capture` always attempts a backtrace regardless of
        // `RUST_BACKTRACE`. A crash is rare and high-value, so the cost is
        // irrelevant; with `[profile.dev] debug = 0` this still yields function
        // symbols (no source line), which is far better than nothing.
        let backtrace = Backtrace::force_capture().to_string();

        tracing::error!(
            target: PANIC_TARGET,
            "{}",
            format_panic(&message, location.as_deref(), &backtrace)
        );

        if let Some(dir) = &crash_dir {
            let details = CrashDetails {
                app: APP_NAME.to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                thread: std::thread::current().name().map(str::to_string),
                location: location.clone(),
                message: message.clone(),
                backtrace: backtrace.clone(),
            };
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

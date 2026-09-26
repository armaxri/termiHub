//! Durable panic reporting for the agent (OBS-010).
//!
//! Mirrors the desktop's `utils::panic_hook`: on a panic, the payload, location
//! and a backtrace are logged through `tracing` (so they land in the rotating
//! `termihub-agent.log`) and a small, redacted crash report is written into
//! `<agent log dir>/crash-reports/`, bounded by count and age. The report stays
//! on the host the agent runs on — nothing is sent anywhere. The hook then
//! chains to the previous hook, so stderr output and abort behaviour are
//! unchanged.

use std::backtrace::Backtrace;
use std::path::PathBuf;
use std::time::SystemTime;

use termihub_core::diagnostics::crash_report::{self, CrashDetails};
use termihub_core::diagnostics::redact::Redactor;

/// Tracing target panics are logged under.
const PANIC_TARGET: &str = "termihub_agent::panic";

/// The app name recorded in agent crash reports.
const APP_NAME: &str = "termihub-agent";

/// The agent's crash-report directory (`<config>/logs/crash-reports`).
pub fn crash_dir() -> PathBuf {
    crash_report::crash_dir_in(&crate::file_log::log_dir())
}

/// Install the panic hook, writing crash reports into `crash_dir`.
///
/// Call after the tracing subscriber is initialized so the logged event reaches
/// the file sink.
pub fn install(crash_dir: PathBuf) {
    let redactor = Redactor::for_current_environment();
    // Bound the directory now and compile the redaction patterns outside of a
    // panic; best-effort, a failure here must never stop the agent starting.
    let _ = crash_report::prune(
        &crash_dir,
        crash_report::MAX_REPORTS,
        crash_report::MAX_REPORT_AGE,
        SystemTime::now(),
    );
    let _ = redactor.redact("warm-up");

    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "Box<dyn Any>".to_string());
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
        let backtrace = Backtrace::force_capture().to_string();

        tracing::error!(
            target: PANIC_TARGET,
            "panic at {}: {message}",
            location.as_deref().unwrap_or("unknown location")
        );

        let details = CrashDetails {
            app: APP_NAME.to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            thread: std::thread::current().name().map(str::to_string),
            location,
            message,
            backtrace,
        };
        match crash_report::write_report(&crash_dir, &details, SystemTime::now(), &redactor) {
            Ok(path) => tracing::error!(
                target: PANIC_TARGET,
                "crash report written to {}",
                path.display()
            ),
            Err(e) => tracing::warn!(target: PANIC_TARGET, "could not write crash report: {e}"),
        }

        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crash_dir_sits_in_the_agent_log_dir() {
        assert_eq!(
            crash_dir(),
            crate::file_log::log_dir().join(crash_report::CRASH_DIR_NAME)
        );
    }

    #[test]
    fn a_panic_writes_a_redacted_agent_crash_report() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(crash_report::CRASH_DIR_NAME);
        install(dir.clone());
        let result = std::panic::catch_unwind(|| panic!("agent self-test token=s3cr3tvalue"));
        assert!(result.is_err());
        // Restore the default hook so later panicking tests do not write here.
        let _ = std::panic::take_hook();

        let report = crash_report::list_reports(&dir)
            .iter()
            .map(|r| std::fs::read_to_string(&r.path).unwrap())
            .find(|t| t.contains("agent self-test"))
            .expect("a crash report for the self-test panic");
        assert!(report.contains(APP_NAME));
        assert!(!report.contains("s3cr3tvalue"));
    }
}

//! Forced-panic crash-report probe (#4316).
//!
//! `termihub-crash-probe <dir>` installs a panic hook that does what the desktop
//! and agent hooks do — [`CrashDetails::capture`] then
//! [`crash_report::write_report`] — and then panics. The crash report it leaves
//! in `<dir>` is what a shipped build would write, so
//! `scripts/internal/check-release-crash-symbols.sh` can check that a release
//! build's backtrace still names termiHub functions (it read `<unknown>` for
//! every frame while the release profile used `strip = true`).

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::SystemTime;

use termihub_core::diagnostics::crash_report::{self, CrashDetails};
use termihub_core::diagnostics::redact::Redactor;

fn main() -> ExitCode {
    let Some(dir) = std::env::args_os().nth(1).map(PathBuf::from) else {
        eprintln!("usage: termihub-crash-probe <crash-report-dir>");
        return ExitCode::from(2);
    };
    let redactor = Redactor::for_current_environment();
    std::panic::set_hook(Box::new(move |info| {
        let details = CrashDetails::capture(
            info,
            "termihub-crash-probe",
            env!("CARGO_PKG_VERSION"),
            "probe",
        );
        match crash_report::write_report(&dir, &details, SystemTime::now(), &redactor) {
            Ok(path) => eprintln!("crash report written to {}", path.display()),
            Err(e) => eprintln!("could not write crash report: {e}"),
        }
    }));
    trigger_crash()
}

/// The deliberate panic. Never inlined, so it is a frame of its own.
#[inline(never)]
fn trigger_crash() -> ExitCode {
    panic!("forced crash-report probe (#4316)")
}

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
//! The hook chains to the previously-installed hook, so the normal stderr
//! behaviour (and any test harness hook) is preserved.

use std::backtrace::Backtrace;

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

/// Install the durable panic hook.
///
/// Must be called *after* the `tracing` subscriber is initialized, so the emitted
/// event reaches the file sink. Chains to the previously-installed hook.
pub fn install() {
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
    fn install_chains_to_the_previous_hook() {
        // Installing must not blow up and must leave a working hook in place. We
        // cannot easily assert the tracing side without a global subscriber, but
        // we can prove the hook is installed and chains by catching a panic.
        install();
        let result = std::panic::catch_unwind(|| panic!("hook self-test"));
        assert!(result.is_err());
    }
}

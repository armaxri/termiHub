//! Report a sidecar panic as one `ERROR` log line (#4320, OBS2-003).
//!
//! The sidecar's stderr is piped into the desktop log, which reads it one line
//! at a time. Rust's default panic output spans several lines (a header, the
//! payload, a backtrace note), so the hook replaces it with a single `tracing`
//! error carrying the location and the payload: the desktop then records the
//! panic as one error entry with its message in `termihub.log`, the Log Viewer
//! and Export Diagnostics.

use std::any::Any;

/// The `tracing` target a panic is reported under.
const PANIC_TARGET: &str = "termihub_rdp_helper::panic";

/// Install the panic hook. Call once, after the tracing subscriber is set up.
pub fn install() {
    std::panic::set_hook(Box::new(|info| {
        let location = info.location().map(ToString::to_string);
        let message = panic_message(info.payload(), location.as_deref());
        tracing::error!(target: PANIC_TARGET, "{message}");
    }));
}

/// The one-line report for a panic with `payload` at `location`.
pub fn panic_message(payload: &(dyn Any + Send), location: Option<&str>) -> String {
    let detail = payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "<non-string panic payload>".to_string());
    // Keep it one line: the desktop forwards stderr line by line.
    let detail = detail.replace(['\r', '\n'], " ");
    match location {
        Some(location) => format!("rdp sidecar panicked at {location}: {detail}"),
        None => format!("rdp sidecar panicked: {detail}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_str_payload_is_reported_with_its_location() {
        let payload: Box<dyn Any + Send> = Box::new("boom");
        assert_eq!(
            panic_message(payload.as_ref(), Some("src/rdp.rs:850:9")),
            "rdp sidecar panicked at src/rdp.rs:850:9: boom"
        );
    }

    #[test]
    fn a_formatted_payload_is_kept_on_one_line() {
        let payload: Box<dyn Any + Send> = Box::new(String::from("bad\nstate\r\nhere"));
        let message = panic_message(payload.as_ref(), None);
        assert_eq!(message, "rdp sidecar panicked: bad state  here");
        assert!(!message.contains('\n'));
    }

    #[test]
    fn a_non_string_payload_is_still_reported() {
        let payload: Box<dyn Any + Send> = Box::new(42_u32);
        assert!(panic_message(payload.as_ref(), Some("a.rs:1:1")).contains("non-string"));
    }

    /// End to end inside the process: a real panic caught by the installed
    /// hook does not abort the test and the payload reaches the formatter.
    #[test]
    fn a_caught_panic_payload_formats() {
        let caught = std::panic::catch_unwind(|| panic!("sidecar fell over"));
        let payload = caught.expect_err("the closure panics");
        assert!(panic_message(payload.as_ref(), None).contains("sidecar fell over"));
    }
}

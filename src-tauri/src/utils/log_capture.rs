use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tracing::field::{Field, Visit};
use tracing::Level;
use tracing_subscriber::layer::Context;
use tracing_subscriber::{EnvFilter, Layer};

/// Maximum number of log entries retained in the ring buffer.
const MAX_BUFFER_SIZE: usize = 2000;

/// Default tracing filter directive.
///
/// Keeps termiHub's own crates (and `frontend::*` events bridged from the UI)
/// at `DEBUG` so the LogViewer stays useful, while silencing noisy third-party
/// dependencies — most notably `russh`, which emits per-packet `DEBUG`/`TRACE`
/// cipher logs that otherwise flood the log even while the app is idle.
const DEFAULT_LOG_DIRECTIVE: &str = "info,termihub=debug,termihub_lib=debug,termihub_core=debug,termihub_agent=debug,frontend=debug,plugin=debug,russh=warn";

/// Static `tracing` target the desktop re-emits agent `--stdio` log records
/// under (#2854, OBS-004). A callsite's target must be static, so the agent's
/// real target travels in the `agent_target` field; [`LogCaptureLayer`] puts it
/// back as the LogViewer entry's target. Sits under `termihub_agent` so the
/// default directive's `termihub_agent=debug` governs it.
pub const AGENT_REEMIT_TARGET: &str = "termihub_agent::remote";

/// Static `tracing` target the desktop re-emits frontend-forwarded log lines
/// under (`record_frontend_log`, OBS-001). Such events carry the forwarding
/// window's label in a `window` field, which [`LogCaptureLayer`] surfaces as
/// [`LogEntry::window`] (#4535).
pub const FRONTEND_LOG_TARGET: &str = "frontend";

/// Build the tracing [`EnvFilter`] used by the application.
///
/// Honors the `RUST_LOG` environment variable when set; otherwise falls back to
/// [`DEFAULT_LOG_DIRECTIVE`].
pub fn default_env_filter() -> EnvFilter {
    EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(DEFAULT_LOG_DIRECTIVE))
}

/// A single captured log entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct LogEntry {
    /// Capture time as an ISO-8601 UTC string with millisecond precision
    /// (e.g. `2026-10-10T12:34:56.789Z`) — the same shape the frontend log
    /// channel uses, so exports read uniformly (#4536). Payloads from before
    /// #4536 carry a local `HH:MM:SS.mmm` here instead.
    pub timestamp: String,
    pub level: String,
    pub target: String,
    pub message: String,
    /// Label of the window a frontend-forwarded entry ([`FRONTEND_LOG_TARGET`])
    /// came from, so a Log Viewer can tell its own echo from another window's
    /// warning (#4535). Absent for every other entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub window: Option<String>,
    /// Capture time as Unix epoch milliseconds: the Log Viewer's chronological
    /// sort key and the source of its locale-formatted display time (#4536).
    /// Optional so payloads from before it existed still parse.
    #[serde(
        default,
        rename = "timestampMs",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(test, ts(optional, type = "number"))]
    pub timestamp_ms: Option<i64>,
}

impl LogEntry {
    /// Build an entry stamped with `now`: an ISO-8601 UTC [`LogEntry::timestamp`]
    /// and the matching epoch-ms [`LogEntry::timestamp_ms`] sort key.
    fn stamped(
        now: chrono::DateTime<chrono::Utc>,
        level: String,
        target: String,
        message: String,
        window: Option<String>,
    ) -> Self {
        Self {
            timestamp: now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            level,
            target,
            message,
            window,
            timestamp_ms: Some(now.timestamp_millis()),
        }
    }
}

/// Ring buffer holding recent log entries.
pub struct LogBuffer {
    entries: VecDeque<LogEntry>,
    capacity: usize,
}

impl LogBuffer {
    fn new(capacity: usize) -> Self {
        Self {
            entries: VecDeque::with_capacity(capacity),
            capacity,
        }
    }

    fn push(&mut self, entry: LogEntry) {
        if self.entries.len() >= self.capacity {
            self.entries.pop_front();
        }
        self.entries.push_back(entry);
    }

    /// Return the most recent `count` entries (or fewer if buffer has less).
    pub fn get_recent(&self, count: usize) -> Vec<LogEntry> {
        let skip = self.entries.len().saturating_sub(count);
        self.entries.iter().skip(skip).cloned().collect()
    }

    /// Clear all buffered entries.
    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

/// Thread-safe shared log buffer, managed as Tauri state.
pub type SharedLogBuffer = Arc<Mutex<LogBuffer>>;

/// Create a new shared log buffer with default capacity.
pub fn create_log_buffer() -> SharedLogBuffer {
    Arc::new(Mutex::new(LogBuffer::new(MAX_BUFFER_SIZE)))
}

/// A `tracing_subscriber::Layer` that captures log events into a ring buffer
/// and optionally emits them as Tauri events when an AppHandle is available.
pub struct LogCaptureLayer {
    buffer: SharedLogBuffer,
    app_handle: Arc<Mutex<Option<AppHandle>>>,
}

impl LogCaptureLayer {
    pub fn new(buffer: SharedLogBuffer) -> Self {
        Self {
            buffer,
            app_handle: Arc::new(Mutex::new(None)),
        }
    }

    /// Return a clone of the app_handle Arc for deferred injection.
    /// Set the inner `Option<AppHandle>` in `.setup()` after the app is initialized.
    pub fn app_handle_slot(&self) -> Arc<Mutex<Option<AppHandle>>> {
        self.app_handle.clone()
    }
}

/// Visitor that extracts the `message` field from a tracing event.
struct MessageVisitor {
    message: String,
    /// The `window` field, recorded for frontend-forwarded events only.
    window: Option<String>,
    capture_window: bool,
}

impl MessageVisitor {
    fn new(capture_window: bool) -> Self {
        Self {
            message: String::new(),
            window: None,
            capture_window,
        }
    }
}

impl Visit for MessageVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{:?}", value);
        } else if self.capture_window && field.name() == "window" {
            self.window = Some(format!("{:?}", value));
        } else if self.message.is_empty() {
            // Fall back to first field if no "message" field
            self.message = format!("{} = {:?}", field.name(), value);
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else if self.capture_window && field.name() == "window" {
            self.window = Some(value.to_string());
        }
    }
}

/// Visitor for a re-emitted agent record ([`AGENT_REEMIT_TARGET`]): collects
/// the message, the agent's real target, and the join fields.
#[derive(Default)]
struct AgentRecordVisitor {
    message: String,
    agent_target: Option<String>,
    agent_id: Option<String>,
    correlation_id: Option<String>,
    agent_fields: Option<String>,
}

impl AgentRecordVisitor {
    fn set(&mut self, name: &str, value: String) {
        match name {
            "message" => self.message = value,
            "agent_target" => self.agent_target = Some(value),
            "agent_id" => self.agent_id = Some(value),
            "correlation_id" => self.correlation_id = Some(value),
            "agent_fields" => self.agent_fields = Some(value),
            _ => {}
        }
    }

    /// The LogViewer entry's `(target, message)`: the agent's real target, and
    /// the message followed by the join/structured fields so a record can be
    /// found by correlation id from the in-app viewer too.
    fn into_target_and_message(self, fallback_target: &str) -> (String, String) {
        let mut message = self.message;
        for (key, value) in [
            ("agent_id", self.agent_id),
            ("correlation_id", self.correlation_id),
        ] {
            if let Some(v) = value {
                message.push_str(&format!(" {key}={v}"));
            }
        }
        if let Some(fields) = self.agent_fields {
            message.push(' ');
            message.push_str(&fields);
        }
        let target = self
            .agent_target
            .unwrap_or_else(|| fallback_target.to_string());
        (target, message)
    }
}

impl Visit for AgentRecordVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.set(field.name(), format!("{:?}", value));
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.set(field.name(), value.to_string());
    }
}

impl<S> Layer<S> for LogCaptureLayer
where
    S: tracing::Subscriber,
{
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: Context<'_, S>) {
        let metadata = event.metadata();
        let level = *metadata.level();

        let (target, message, window) = if metadata.target() == AGENT_REEMIT_TARGET {
            let mut visitor = AgentRecordVisitor::default();
            event.record(&mut visitor);
            let (target, message) = visitor.into_target_and_message(metadata.target());
            (target, message, None)
        } else {
            let mut visitor = MessageVisitor::new(metadata.target() == FRONTEND_LOG_TARGET);
            event.record(&mut visitor);
            (
                metadata.target().to_string(),
                visitor.message,
                visitor.window,
            )
        };

        let entry = LogEntry::stamped(
            chrono::Utc::now(),
            level_to_string(level),
            target,
            message,
            window,
        );

        // Buffer the entry
        if let Ok(mut buf) = self.buffer.lock() {
            buf.push(entry.clone());
        }

        // Emit to frontend if AppHandle is available
        if let Ok(handle) = self.app_handle.lock() {
            if let Some(ref h) = *handle {
                let _ = h.emit("log-entry", &entry);
            }
        }
    }
}

fn level_to_string(level: Level) -> String {
    match level {
        Level::ERROR => "ERROR".to_string(),
        Level::WARN => "WARN".to_string(),
        Level::INFO => "INFO".to_string(),
        Level::DEBUG => "DEBUG".to_string(),
        Level::TRACE => "TRACE".to_string(),
    }
}

/// Deterministic thread-scoped `tracing` subscribers for tests.
///
/// # Why tests must not call `tracing::subscriber::{with_default, set_default}` directly
///
/// `tracing-core` caches each callsite's [`Interest`](tracing::subscriber::Interest)
/// globally, the first time any thread hits it. While at most one dispatcher
/// is registered process-wide, it takes a lock-free "just one" fast path and
/// computes that interest from the *registering thread's* default subscriber
/// only. So when a single test holds a scoped capture subscriber and another
/// test thread (with no subscriber) is the first to hit a shared callsite —
/// e.g. `credential migration complete` in `migrate_credentials`, which
/// several tests call — the callsite is cached as `never` and the capturing
/// test silently loses the event. Measured at ~0.7% of runs of
/// `commands::credential` under `--test-threads=16` before this fix.
///
/// Pinning two never-dropped no-op dispatchers keeps the registry permanently
/// at two or more entries, which disables that fast path: every callsite
/// registration then consults all live dispatchers under the registry lock,
/// so a scoped subscriber always sees its callsites (a no-op dispatcher only
/// widens a cached interest to `sometimes`, never narrows it). The same fast
/// path let a `reload` handle's interest-cache rebuild on another thread reset
/// the global max level to `OFF` mid-test, which is what the former
/// `serial(tracing_default_subscriber)` group worked around — and serializing
/// made it worse, since it guaranteed a lone scoped dispatcher.
#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::OnceLock;

    use tracing::subscriber::{DefaultGuard, NoSubscriber};
    use tracing::{Dispatch, Subscriber};

    static PINNED_DISPATCHERS: OnceLock<[Dispatch; 2]> = OnceLock::new();

    /// Keep the dispatcher registry off the "just one" fast path for the rest
    /// of the process. Also call this before anything that rebuilds the
    /// interest cache (e.g. `reload::Handle::reload`): on the fast path a
    /// rebuild from a thread without a subscriber resets the global max level
    /// to `OFF` and every cached callsite interest to `never`.
    pub(crate) fn pin_multi_dispatcher_registry() {
        PINNED_DISPATCHERS.get_or_init(|| {
            [
                Dispatch::new(NoSubscriber::default()),
                Dispatch::new(NoSubscriber::default()),
            ]
        });
    }

    /// Run `f` with `subscriber` as this thread's default subscriber.
    pub(crate) fn with_scoped_subscriber<S, T>(subscriber: S, f: impl FnOnce() -> T) -> T
    where
        S: Subscriber + Send + Sync + 'static,
    {
        pin_multi_dispatcher_registry();
        tracing::subscriber::with_default(subscriber, f)
    }

    /// Install `subscriber` as this thread's default until the guard drops.
    pub(crate) fn set_scoped_subscriber<S>(subscriber: S) -> DefaultGuard
    where
        S: Subscriber + Send + Sync + 'static,
    {
        pin_multi_dispatcher_registry();
        tracing::subscriber::set_default(subscriber)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffer_respects_capacity_limit() {
        let mut buffer = LogBuffer::new(3);
        for i in 0..5 {
            buffer.push(LogEntry {
                timestamp: format!("t{}", i),
                level: "INFO".to_string(),
                target: "test".to_string(),
                message: format!("msg {}", i),
                window: None,
                timestamp_ms: None,
            });
        }
        // Only the last 3 should remain
        assert_eq!(buffer.entries.len(), 3);
        let recent = buffer.get_recent(10);
        assert_eq!(recent.len(), 3);
        assert_eq!(recent[0].message, "msg 2");
        assert_eq!(recent[1].message, "msg 3");
        assert_eq!(recent[2].message, "msg 4");
    }

    #[test]
    fn get_recent_returns_correct_count() {
        let mut buffer = LogBuffer::new(10);
        for i in 0..5 {
            buffer.push(LogEntry {
                timestamp: format!("t{}", i),
                level: "INFO".to_string(),
                target: "test".to_string(),
                message: format!("msg {}", i),
                window: None,
                timestamp_ms: None,
            });
        }
        let recent = buffer.get_recent(2);
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].message, "msg 3");
        assert_eq!(recent[1].message, "msg 4");
    }

    #[test]
    fn get_recent_with_count_larger_than_buffer() {
        let mut buffer = LogBuffer::new(10);
        for i in 0..3 {
            buffer.push(LogEntry {
                timestamp: format!("t{}", i),
                level: "INFO".to_string(),
                target: "test".to_string(),
                message: format!("msg {}", i),
                window: None,
                timestamp_ms: None,
            });
        }
        let recent = buffer.get_recent(100);
        assert_eq!(recent.len(), 3);
    }

    #[test]
    fn clear_empties_buffer() {
        let mut buffer = LogBuffer::new(10);
        for i in 0..5 {
            buffer.push(LogEntry {
                timestamp: format!("t{}", i),
                level: "INFO".to_string(),
                target: "test".to_string(),
                message: format!("msg {}", i),
                window: None,
                timestamp_ms: None,
            });
        }
        assert_eq!(buffer.entries.len(), 5);
        buffer.clear();
        assert_eq!(buffer.entries.len(), 0);
        assert_eq!(buffer.get_recent(10).len(), 0);
    }

    #[test]
    fn layer_captures_tracing_events() {
        use tracing_subscriber::layer::SubscriberExt;

        let buffer = create_log_buffer();
        let layer = LogCaptureLayer::new(buffer.clone());

        let subscriber = tracing_subscriber::registry().with(layer);
        let _guard = test_support::set_scoped_subscriber(subscriber);

        tracing::info!(target: "test_target", "hello from tracing");

        let entries = buffer.lock().unwrap().get_recent(10);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].level, "INFO");
        assert_eq!(entries[0].target, "test_target");
        assert!(entries[0].message.contains("hello from tracing"));
    }

    #[test]
    fn default_filter_silences_russh_but_keeps_app_debug() {
        use tracing_subscriber::layer::SubscriberExt;

        let buffer = create_log_buffer();
        let layer = LogCaptureLayer::new(buffer.clone());

        let subscriber = tracing_subscriber::registry()
            .with(default_env_filter())
            .with(layer);
        let _guard = test_support::set_scoped_subscriber(subscriber);

        // Noisy dependency spam (the bug): must be filtered out.
        tracing::debug!(target: "russh::cipher", "reading, seqn = 603");
        tracing::trace!(target: "russh::client::encrypted", "process_packet");
        // Application-level debug (frontend bridge): must be kept.
        tracing::debug!(target: "frontend::terminal", "frontend debug message");

        let entries = buffer.lock().unwrap().get_recent(10);
        assert_eq!(
            entries.len(),
            1,
            "only the frontend debug entry should survive the filter, got: {entries:?}"
        );
        assert_eq!(entries[0].target, "frontend::terminal");
    }

    #[test]
    fn window_field_is_only_surfaced_for_frontend_events() {
        use tracing_subscriber::layer::SubscriberExt;

        let buffer = create_log_buffer();
        let layer = LogCaptureLayer::new(buffer.clone());
        let subscriber = tracing_subscriber::registry().with(layer);
        let _guard = test_support::set_scoped_subscriber(subscriber);

        tracing::warn!(target: FRONTEND_LOG_TARGET, window = "main", "forwarded");
        tracing::info!(target: "termihub::window", window = "main", "unrelated");

        let entries = buffer.lock().unwrap().get_recent(10);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].window.as_deref(), Some("main"));
        assert_eq!(entries[0].message, "forwarded");
        assert_eq!(entries[1].window, None);
    }

    #[test]
    fn captured_entry_carries_iso_utc_timestamp_and_epoch_ms_sort_key() {
        use tracing_subscriber::layer::SubscriberExt;

        let buffer = create_log_buffer();
        let layer = LogCaptureLayer::new(buffer.clone());
        let subscriber = tracing_subscriber::registry().with(layer);
        let _guard = test_support::set_scoped_subscriber(subscriber);

        let before = chrono::Utc::now().timestamp_millis();
        tracing::info!(target: "test_target", "stamped");
        let after = chrono::Utc::now().timestamp_millis();

        let entries = buffer.lock().unwrap().get_recent(10);
        assert_eq!(entries.len(), 1);
        let ms = entries[0]
            .timestamp_ms
            .expect("new entries carry timestampMs");
        assert!(
            (before..=after).contains(&ms),
            "{ms} not in {before}..={after}"
        );
        let parsed = chrono::DateTime::parse_from_rfc3339(&entries[0].timestamp)
            .expect("timestamp is RFC 3339");
        assert_eq!(parsed.timestamp_millis(), ms);
        assert!(
            entries[0].timestamp.ends_with('Z'),
            "UTC: {}",
            entries[0].timestamp
        );
    }

    #[test]
    fn timestamp_ms_serializes_camel_case_and_is_optional_on_input() {
        let now = chrono::DateTime::from_timestamp_millis(1_760_000_000_123).unwrap();
        let entry = LogEntry::stamped(now, "INFO".into(), "t".into(), "m".into(), None);
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json["timestampMs"], 1_760_000_000_123_i64);
        assert_eq!(json["timestamp"], "2025-10-09T08:53:20.123Z");

        // A pre-#4536 payload (no `timestampMs`, local clock string) still parses.
        let old: LogEntry = serde_json::from_str(
            r#"{"timestamp":"12:34:56.789","level":"WARN","target":"t","message":"m"}"#,
        )
        .unwrap();
        assert_eq!(old.timestamp_ms, None);
        assert_eq!(old.timestamp, "12:34:56.789");
        // ...and an entry without the key does not emit it.
        let json = serde_json::to_value(&old).unwrap();
        assert!(json.get("timestampMs").is_none());
    }
}

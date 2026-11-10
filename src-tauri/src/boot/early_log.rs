//! Tracing for the boot steps that run before the global subscriber exists
//! (#5210).
//!
//! The portable data-dir lock must be taken **before** the durable log file
//! opens: in portable mode the log lives in `<data>/logs`, so opening it first
//! would make a refused second instance create or append that shared file (and
//! possibly rotate the log the live instance is writing to).
//!
//! [`run_buffered`] runs such a step under a scoped, file-less subscriber:
//! warnings and errors go straight to stderr (so the "already running" refusal
//! is still visible even though the process exits inside the step), and every
//! event is buffered. Once the global subscriber — file sink included — is live,
//! [`EarlyLog::replay`] re-emits the buffered events so they still land in
//! `termihub.log` and the LogViewer ring buffer.

use std::fmt::Write as _;
use std::sync::{Arc, Mutex};

use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::Layer;

use crate::utils::log_capture::default_env_filter;

/// One event captured before the global subscriber existed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EarlyEvent {
    /// The event's level.
    pub(crate) level: Level,
    /// The event's original target (module path).
    pub(crate) target: String,
    /// The message plus any extra fields, formatted as `message key=value …`.
    pub(crate) message: String,
}

/// Events buffered by [`run_buffered`], to be replayed once the global
/// subscriber is installed.
#[derive(Debug, Default)]
#[must_use = "buffered boot events are lost unless replayed"]
pub(crate) struct EarlyLog {
    events: Vec<EarlyEvent>,
}

impl EarlyLog {
    /// The buffered events, in emission order.
    #[cfg(test)]
    pub(crate) fn events(&self) -> &[EarlyEvent] {
        &self.events
    }

    /// Re-emit every buffered event through the current (global) subscriber,
    /// keeping its level and recording its original target as `origin`.
    pub(crate) fn replay(self) {
        for EarlyEvent {
            level,
            target,
            message,
        } in self.events
        {
            match level {
                Level::ERROR => tracing::error!(origin = %target, "{message}"),
                Level::WARN => tracing::warn!(origin = %target, "{message}"),
                Level::INFO => tracing::info!(origin = %target, "{message}"),
                Level::DEBUG => tracing::debug!(origin = %target, "{message}"),
                Level::TRACE => tracing::trace!(origin = %target, "{message}"),
            }
        }
    }
}

/// Run `f` under a scoped subscriber that writes warnings and errors to stderr
/// and buffers every event (subject to the usual `RUST_LOG` envelope) for a
/// later [`EarlyLog::replay`]. Opens no file.
pub(crate) fn run_buffered<T>(f: impl FnOnce() -> T) -> (T, EarlyLog) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let subscriber = tracing_subscriber::registry()
        .with(default_env_filter())
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(std::io::stderr)
                .with_filter(LevelFilter::WARN),
        )
        .with(BufferLayer {
            events: events.clone(),
        });
    let value = tracing::subscriber::with_default(subscriber, f);
    let events = std::mem::take(&mut *events.lock().unwrap_or_else(|e| e.into_inner()));
    (value, EarlyLog { events })
}

/// Layer that records each event into a shared vector.
struct BufferLayer {
    events: Arc<Mutex<Vec<EarlyEvent>>>,
}

impl<S: Subscriber> Layer<S> for BufferLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);
        let meta = event.metadata();
        let captured = EarlyEvent {
            level: *meta.level(),
            target: meta.target().to_string(),
            message: visitor.finish(),
        };
        self.events
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(captured);
    }
}

/// Flattens an event's fields into `message key=value …`.
#[derive(Default)]
struct MessageVisitor {
    message: String,
    fields: String,
}

impl MessageVisitor {
    fn push_field(&mut self, name: &str, value: std::fmt::Arguments<'_>) {
        let _ = write!(self.fields, " {name}={value}");
    }

    fn finish(self) -> String {
        format!("{}{}", self.message, self.fields)
    }
}

impl Visit for MessageVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else {
            self.push_field(field.name(), format_args!("{value}"));
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{value:?}");
        } else {
            self.push_field(field.name(), format_args!("{value:?}"));
        }
    }
}

#[cfg(test)]
#[path = "early_log_tests.rs"]
mod tests;

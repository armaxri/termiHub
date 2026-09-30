//! Encoder for the agent's structured stderr log side-band (#2854, OBS-004).
//!
//! The wire format — [`LogFrame`], [`FRAME_PREFIX`], [`parse_line`] — lives in
//! [`termihub_core::protocol::log_frame`] so the desktop parses exactly what the
//! agent writes; it is re-exported here. This module adds the
//! [`FramedStderrLayer`] the `--stdio` role installs: every `tracing` event is
//! written to stderr as one framed line carrying its level, target, message,
//! structured fields (event fields over enclosing span fields, secret-named
//! fields redacted) and the desktop correlation id.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::io::Write as _;

use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Subscriber};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::registry::LookupSpan;

pub use termihub_core::protocol::log_frame::*;

// ---------------------------------------------------------------------------
// Encoder layer
// ---------------------------------------------------------------------------

/// Field values collected from a span or event.
#[derive(Debug, Default, Clone)]
struct FieldMap {
    message: Option<String>,
    fields: BTreeMap<String, String>,
}

impl FieldMap {
    fn insert(&mut self, name: &str, value: String) {
        if name == "message" {
            self.message = Some(value);
        } else if name.starts_with("log.") {
            // `tracing-log` bridge metadata; not part of the record.
        } else if is_secret_field(name) {
            self.fields.insert(name.to_string(), REDACTED.to_string());
        } else {
            self.fields.insert(name.to_string(), value);
        }
    }
}

impl Visit for FieldMap {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.insert(field.name(), value.to_string());
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let mut s = String::new();
        let _ = write!(s, "{value:?}");
        self.insert(field.name(), s);
    }
}

/// A `tracing` layer that writes every event as one framed stderr line.
///
/// Generic over the writer so tests (and the desktop's contract test) can
/// capture the exact bytes; the agent installs it with `std::io::stderr`.
pub struct FramedStderrLayer<W> {
    make_writer: W,
}

impl<W> FramedStderrLayer<W> {
    /// Create a layer writing framed lines through `make_writer`.
    pub fn new(make_writer: W) -> Self {
        Self { make_writer }
    }
}

impl<S, W> Layer<S> for FramedStderrLayer<W>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    W: for<'w> MakeWriter<'w> + 'static,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let mut fields = FieldMap::default();
        attrs.record(&mut fields);
        if let Some(span) = ctx.span(id) {
            span.extensions_mut().insert(fields);
        }
    }

    fn on_record(&self, id: &Id, values: &Record<'_>, ctx: Context<'_, S>) {
        if let Some(span) = ctx.span(id) {
            let mut ext = span.extensions_mut();
            if let Some(fields) = ext.get_mut::<FieldMap>() {
                values.record(fields);
            }
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        let mut own = FieldMap::default();
        event.record(&mut own);

        // Innermost span first, so the nearest value of a field wins.
        let mut fields = own.fields;
        if let Some(scope) = ctx.event_scope(event) {
            for span in scope {
                if let Some(span_fields) = span.extensions().get::<FieldMap>() {
                    for (k, v) in &span_fields.fields {
                        fields.entry(k.clone()).or_insert_with(|| v.clone());
                    }
                }
            }
        }

        // Hoist the desktop correlation id; only a well-formed one is carried
        // (the dispatch layer already drops malformed ids, this is defense in
        // depth so the field can never inject into the desktop log).
        let cid = fields
            .remove(CORRELATION_FIELD)
            .filter(|id| termihub_core::protocol::methods::is_valid_correlation_id(id));

        let fields: BTreeMap<String, String> = fields
            .into_iter()
            .take(MAX_FIELDS)
            .map(|(k, v)| (k, truncate(v, MAX_FIELD_BYTES)))
            .collect();

        let meta = event.metadata();
        let frame = LogFrame {
            ts: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
            level: meta.level().as_str().to_string(),
            target: meta.target().to_string(),
            msg: truncate(own.message.unwrap_or_default(), MAX_MESSAGE_BYTES),
            cid,
            fields,
        };

        let mut line = encode_line(&frame);
        line.push('\n');
        // One write per record, so concurrent records never interleave mid-line.
        let mut writer = self.make_writer.make_writer();
        let _ = writer.write_all(line.as_bytes());
        let _ = writer.flush();
    }
}

#[cfg(test)]
#[path = "log_frame_tests.rs"]
mod tests;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};
use tracing_subscriber::registry::LookupSpan;

#[derive(Default, Clone)]
struct Fields(BTreeMap<String, String>);

impl Visit for Fields {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.insert(field.name().to_string(), value.to_string());
    }
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        // `%value` (Display) and the log message both arrive here as
        // `format_args`, whose `Debug` renders the unquoted string.
        self.0
            .insert(field.name().to_string(), format!("{value:?}"));
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.0.insert(field.name().to_string(), value.to_string());
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.0.insert(field.name().to_string(), value.to_string());
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.0.insert(field.name().to_string(), value.to_string());
    }
}

/// One captured log event: the innermost span name (if any) plus the merged
/// field set (event fields override inherited span fields).
#[derive(Clone, Debug)]
pub(crate) struct CapturedEvent {
    pub span: Option<String>,
    pub fields: BTreeMap<String, String>,
}

impl CapturedEvent {
    pub fn message(&self) -> &str {
        self.fields.get("message").map(String::as_str).unwrap_or("")
    }
    pub fn field(&self, name: &str) -> Option<&str> {
        self.fields.get(name).map(String::as_str)
    }
}

#[derive(Clone, Default)]
pub(crate) struct CaptureLayer {
    events: Arc<Mutex<Vec<CapturedEvent>>>,
}

impl CaptureLayer {
    pub fn events(&self) -> Vec<CapturedEvent> {
        self.events.lock().expect("capture lock").clone()
    }
}

impl<S> Layer<S> for CaptureLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let mut fields = Fields::default();
        attrs.record(&mut fields);
        if let Some(span) = ctx.span(id) {
            span.extensions_mut().insert(fields);
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        let mut fields = Fields::default();
        event.record(&mut fields);

        let mut span_name = None;
        if let Some(scope) = ctx.event_scope(event) {
            // Innermost first: remember the immediate span name, then fold in
            // every ancestor's fields without clobbering the event's own.
            for (depth, span) in scope.enumerate() {
                if depth == 0 {
                    span_name = Some(span.name().to_string());
                }
                if let Some(sf) = span.extensions().get::<Fields>() {
                    for (k, v) in &sf.0 {
                        fields.0.entry(k.clone()).or_insert_with(|| v.clone());
                    }
                }
            }
        }

        self.events
            .lock()
            .expect("capture lock")
            .push(CapturedEvent {
                span: span_name,
                fields: fields.0,
            });
    }
}

/// Install the capture layer as the thread-local default subscriber. The
/// returned guard keeps it active until dropped; the handle exposes the
/// captured events. Use on a current-thread runtime so the guard spans all
/// `await` points on the test thread.
pub(crate) fn install() -> (CaptureLayer, tracing::subscriber::DefaultGuard) {
    let layer = CaptureLayer::default();
    let subscriber = tracing_subscriber::registry().with(layer.clone());
    let guard = crate::utils::log_capture::test_support::set_scoped_subscriber(subscriber);
    (layer, guard)
}

//! `connection.create` correlation id (#3085, OBS-004): the agent runs the
//! create under an `agent_session` span carrying the desktop's
//! `correlation_id`, so agent log lines join the desktop's `termihub.log`.
//! Asserted with a capturing `tracing` layer; the id must be a structured
//! field, never interpolated into a message.

use std::collections::BTreeMap;
use std::sync::Mutex as StdMutex;

use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};
use tracing_subscriber::registry::LookupSpan;

use super::*;

#[derive(Default, Clone)]
struct Fields(BTreeMap<String, String>);

impl Visit for Fields {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.insert(field.name().to_string(), value.to_string());
    }
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.0
            .insert(field.name().to_string(), format!("{value:?}"));
    }
}

/// Events with their own fields merged over every enclosing span's fields.
#[derive(Clone, Default)]
struct Capture(Arc<StdMutex<Vec<BTreeMap<String, String>>>>);

impl Capture {
    fn events_with_message(&self, message: &str) -> Vec<BTreeMap<String, String>> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.get("message").map(String::as_str) == Some(message))
            .cloned()
            .collect()
    }
}

impl<S> Layer<S> for Capture
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

    fn on_record(&self, id: &Id, values: &Record<'_>, ctx: Context<'_, S>) {
        if let Some(span) = ctx.span(id) {
            let mut ext = span.extensions_mut();
            if let Some(fields) = ext.get_mut::<Fields>() {
                values.record(fields);
            }
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        let mut fields = Fields::default();
        event.record(&mut fields);
        if let Some(scope) = ctx.event_scope(event) {
            for span in scope {
                fields
                    .0
                    .entry("span".to_string())
                    .or_insert_with(|| span.name().to_string());
                if let Some(sf) = span.extensions().get::<Fields>() {
                    for (k, v) in &sf.0 {
                        fields.0.entry(k.clone()).or_insert_with(|| v.clone());
                    }
                }
            }
        }
        self.0.lock().unwrap().push(fields.0);
    }
}

/// Install the capture as this thread's default subscriber. Pins two no-op
/// dispatchers first so a parallel test cannot cache a shared callsite's
/// interest as `never` for this subscriber (see `file_log`'s tests).
fn install() -> (Capture, tracing::subscriber::DefaultGuard) {
    use tracing::subscriber::NoSubscriber;
    use tracing::Dispatch;
    static PINNED: OnceLock<[Dispatch; 2]> = OnceLock::new();
    PINNED.get_or_init(|| {
        [
            Dispatch::new(NoSubscriber::default()),
            Dispatch::new(NoSubscriber::default()),
        ]
    });
    let capture = Capture::default();
    let guard =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(capture.clone()));
    (capture, guard)
}

const CREATED: &str = "agent session created";

#[tokio::test]
async fn connection_create_logs_under_the_desktop_correlation_id() {
    let (capture, _guard) = install();
    let handler = make_mock_handler();
    init_handler(&handler).await;

    let r = dispatch(
        &handler,
        "connection.create",
        json!({"type": "local", "config": {}, "correlation_id": "desk-sid-1"}),
        2,
    )
    .await;
    let agent_sid = r["result"]["session_id"]
        .as_str()
        .expect("created")
        .to_string();

    let events = capture.events_with_message(CREATED);
    assert_eq!(events.len(), 1, "{events:?}");
    let e = &events[0];
    assert_eq!(e.get("span").map(String::as_str), Some("agent_session"));
    assert_eq!(
        e.get("correlation_id").map(String::as_str),
        Some("desk-sid-1")
    );
    assert_eq!(e.get("session_id"), Some(&agent_sid));
    assert_eq!(e.get("type_id").map(String::as_str), Some("local"));
}

#[tokio::test]
async fn connection_create_without_correlation_id_still_works() {
    // An older desktop sends no id: the create succeeds and the span simply
    // carries no `correlation_id` field.
    let (capture, _guard) = install();
    let handler = make_mock_handler();
    init_handler(&handler).await;

    let r = dispatch(
        &handler,
        "connection.create",
        json!({"type": "local", "config": {}}),
        2,
    )
    .await;
    assert!(r.get("result").is_some(), "{r}");

    let events = capture.events_with_message(CREATED);
    assert_eq!(events.len(), 1, "{events:?}");
    assert!(!events[0].contains_key("correlation_id"), "{events:?}");
    assert!(events[0].contains_key("session_id"), "{events:?}");
}

#[tokio::test]
async fn connection_create_drops_a_malformed_correlation_id() {
    let (capture, _guard) = install();
    let handler = make_mock_handler();
    init_handler(&handler).await;

    let r = dispatch(
        &handler,
        "connection.create",
        json!({"type": "local", "config": {}, "correlation_id": "evil\nforged line"}),
        2,
    )
    .await;
    assert!(
        r.get("result").is_some(),
        "a bad id must not fail the create: {r}"
    );

    let events = capture.events_with_message(CREATED);
    assert_eq!(events.len(), 1, "{events:?}");
    assert!(!events[0].contains_key("correlation_id"), "{events:?}");
}

#[test]
fn nested_create_events_inherit_the_correlation_id() {
    // Everything the create logs (daemon spawn, SSH handshake, prompts) runs
    // inside the span, so it carries the id without naming it.
    let (capture, _guard) = install();
    let span = session_create_span("ssh", Some("desk-sid-2"));
    span.in_scope(|| tracing::warn!("ssh handshake slow"));

    let events = capture.events_with_message("ssh handshake slow");
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(
        events[0].get("correlation_id").map(String::as_str),
        Some("desk-sid-2")
    );
    assert_eq!(events[0].get("type_id").map(String::as_str), Some("ssh"));
}

//! What happened to each service (#6028, slice 9): its states one after the
//! other, with why, in a bounded ring per service. Kept in memory only, for
//! both kinds, from the views every window gets; an agent-hosted service shows
//! what the desktop saw.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

/// How many events a service keeps.
pub const EVENTS_KEPT: usize = 200;

/// One change of a service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct ServiceEvent {
    /// When, in milliseconds since 1970.
    #[cfg_attr(test, ts(type = "number"))]
    pub at_ms: u64,
    /// Its status, as the view names it (`running`, `error`, …).
    pub status: String,
    /// Why, when the view says it.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub reason: Option<String>,
}

#[derive(Default)]
struct Inner {
    events: HashMap<String, VecDeque<ServiceEvent>>,
    /// The last status and reason seen, so that only changes are kept.
    last: HashMap<String, (String, Option<String>)>,
}

/// The events of every service, by id. A deleted service keeps its few events
/// until termiHub closes, so that undoing the delete keeps them too.
#[derive(Default)]
pub struct ServiceEvents {
    inner: Mutex<Inner>,
}

fn now_ms() -> u64 {
    let since = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    since.as_millis() as u64
}

impl ServiceEvents {
    /// Note what `states` (id to a state with `status` and `error`) says, at `at_ms`.
    pub fn note_at(&self, states: &serde_json::Map<String, Value>, at_ms: u64) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        for (id, state) in states {
            let Some(status) = state["status"].as_str() else {
                continue;
            };
            let reason = state["error"].as_str().map(str::to_string);
            let now = (status.to_string(), reason.clone());
            if inner.last.get(id) == Some(&now) {
                continue;
            }
            inner.last.insert(id.clone(), now);
            let events = inner.events.entry(id.clone()).or_default();
            if events.len() == EVENTS_KEPT {
                events.pop_front();
            }
            events.push_back(ServiceEvent {
                at_ms,
                status: status.to_string(),
                reason,
            });
        }
    }

    /// Note the `states` of a view that is published now.
    pub fn note(&self, view: &Value) {
        if let Some(states) = view["states"].as_object() {
            self.note_at(states, now_ms());
        }
    }

    /// The events of `id`, the oldest first.
    pub fn of(&self, id: &str) -> Vec<ServiceEvent> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .events
            .get(id)
            .map(|events| events.iter().cloned().collect())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn note(events: &ServiceEvents, at: u64, states: Value) {
        events.note_at(states.as_object().unwrap(), at);
    }

    #[test]
    fn keeps_each_change_once_with_why() {
        let events = ServiceEvents::default();
        note(&events, 1, json!({ "a": { "status": "starting" } }));
        note(
            &events,
            2,
            json!({ "a": { "status": "starting", "stats": 1 } }),
        );
        note(
            &events,
            3,
            json!({ "a": { "status": "error", "error": "Port 80 is in use." } }),
        );
        note(
            &events,
            4,
            json!({ "a": { "status": "error", "error": "Port 81 is in use." } }),
        );
        note(
            &events,
            5,
            json!({ "b": { "status": "running" }, "c": { "nothing": 1 } }),
        );
        let a = events.of("a");
        assert_eq!(
            a.iter()
                .map(|e| (e.at_ms, e.status.as_str()))
                .collect::<Vec<_>>(),
            [(1, "starting"), (3, "error"), (4, "error")]
        );
        assert_eq!(a[1].reason.as_deref(), Some("Port 80 is in use."));
        assert_eq!(events.of("b").len(), 1);
        assert!(events.of("c").is_empty());
    }

    #[test]
    fn keeps_the_last_ones() {
        let events = ServiceEvents::default();
        for at in 0..(EVENTS_KEPT as u64 + 5) {
            let status = if at % 2 == 0 {
                "running"
            } else {
                "reconnecting"
            };
            note(&events, at, json!({ "a": { "status": status } }));
        }
        let a = events.of("a");
        assert_eq!(a.len(), EVENTS_KEPT);
        assert_eq!(a[0].at_ms, 5);
        assert_eq!(a.last().unwrap().at_ms, EVENTS_KEPT as u64 + 4);
    }

    #[test]
    fn a_published_view_is_noted_now() {
        let events = ServiceEvents::default();
        events.note(&json!({ "states": { "a": { "status": "running" } } }));
        events.note(&json!({ "no states": {} }));
        let at = events.of("a")[0].at_ms;
        assert!(at > 1_700_000_000_000, "{at}");
    }
}

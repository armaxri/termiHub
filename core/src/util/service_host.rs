//! Which machine a saved service (embedded server, SSH tunnel) runs on
//! (#6028).
//!
//! The stored field is one of
//!
//! * absent: this computer, as every entry written before the field existed;
//! * `{"kind": "thisComputer"}`;
//! * `{"kind": "agent", "agentId": "<id>"}`.
//!
//! Anything else (a newer build's kind, an unknown key beside a known kind, a
//! damaged value, `null`) is **unreadable**. A service with an unreadable host
//! must not start: the caller cannot know where it belongs, and opening its
//! port on this computer instead would expose it on the wrong machine. The raw
//! value is kept verbatim, so a save by this build does not destroy it.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Value};

/// The stored host of a service, verbatim. Read it with [`choice`](Self::choice).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ServiceHost(Option<Value>);

/// What a [`ServiceHost`] says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostChoice<'a> {
    /// This computer.
    ThisComputer,
    /// The agent with this id.
    Agent(&'a str),
    /// Something this build cannot read. Never to be treated as this computer.
    Unreadable,
}

impl ServiceHost {
    /// This computer, stated explicitly.
    pub fn this_computer() -> Self {
        Self(Some(json!({ "kind": "thisComputer" })))
    }

    /// The agent `id`.
    pub fn agent(id: impl Into<String>) -> Self {
        Self(Some(json!({ "kind": "agent", "agentId": id.into() })))
    }

    /// Whether no host is stored. Says nothing on the wire, and on a save it
    /// means "keep what is stored" (see [`keep_if_absent`](Self::keep_if_absent)).
    pub fn is_absent(&self) -> bool {
        self.0.is_none()
    }

    /// Where the service runs.
    pub fn choice(&self) -> HostChoice<'_> {
        let Some(value) = &self.0 else {
            return HostChoice::ThisComputer;
        };
        let Some(object) = value.as_object() else {
            return HostChoice::Unreadable;
        };
        match (
            object.get("kind").and_then(Value::as_str),
            object.get("agentId"),
            object.len(),
        ) {
            (Some("thisComputer"), None, 1) => HostChoice::ThisComputer,
            (Some("agent"), Some(Value::String(id)), 2) if !id.is_empty() => HostChoice::Agent(id),
            _ => HostChoice::Unreadable,
        }
    }

    /// For a save that replaces `stored`: an incoming entry without a host
    /// keeps the stored one. A copy that never knew the host (an old list in
    /// another window) must not move the service to this computer.
    pub fn keep_if_absent(&mut self, stored: &Self) {
        if self.is_absent() {
            *self = stored.clone();
        }
    }
}

impl Serialize for ServiceHost {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ServiceHost {
    /// Accepts any value. `null` is a present, unreadable host, not an absent
    /// one, so `#[serde(default)]` alone decides absence.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Value::deserialize(deserializer).map(|value| Self(Some(value)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Entry {
        #[serde(default, skip_serializing_if = "ServiceHost::is_absent")]
        host: ServiceHost,
    }

    fn entry(json: Value) -> Entry {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn absent_and_explicit_this_computer_are_this_computer() {
        assert_eq!(entry(json!({})).host.choice(), HostChoice::ThisComputer);
        assert_eq!(
            entry(json!({"host": {"kind": "thisComputer"}}))
                .host
                .choice(),
            HostChoice::ThisComputer
        );
        assert_eq!(
            ServiceHost::this_computer().choice(),
            HostChoice::ThisComputer
        );
        assert_eq!(ServiceHost::default().choice(), HostChoice::ThisComputer);
    }

    #[test]
    fn an_agent_is_read_back_by_id() {
        assert_eq!(
            entry(json!({"host": {"kind": "agent", "agentId": "a"}}))
                .host
                .choice(),
            HostChoice::Agent("a")
        );
        assert_eq!(ServiceHost::agent("a").choice(), HostChoice::Agent("a"));
    }

    #[test]
    fn anything_else_is_unreadable_and_kept_verbatim() {
        for host in [
            Value::Null,
            json!(true),
            json!("thisComputer"),
            json!([]),
            json!({}),
            json!({"kind": null}),
            json!({"kind": "agent"}),
            json!({"kind": "agent", "agentId": ""}),
            json!({"kind": "agent", "agentId": null}),
            json!({"kind": "agent", "agentId": "a", "container": "c"}),
            json!({"kind": "thisComputer", "agentId": "a"}),
            json!({"kind": "thisComputer", "jail": "/srv"}),
            json!({"kind": "ThisComputer"}),
            json!({"kind": "cluster"}),
        ] {
            let stored = json!({ "host": host });
            let entry = entry(stored.clone());
            assert_eq!(entry.host.choice(), HostChoice::Unreadable, "{stored}");
            assert!(!entry.host.is_absent(), "{stored}");
            assert_eq!(serde_json::to_value(&entry).unwrap(), stored);
        }
    }

    #[test]
    fn an_absent_host_stays_absent_on_the_wire() {
        assert_eq!(serde_json::to_value(entry(json!({}))).unwrap(), json!({}));
    }

    #[test]
    fn only_an_absent_host_takes_over_the_stored_one() {
        let stored = ServiceHost::agent("a");
        let mut absent = ServiceHost::default();
        absent.keep_if_absent(&stored);
        assert_eq!(absent, stored);
        let mut here = ServiceHost::this_computer();
        here.keep_if_absent(&stored);
        assert_eq!(here, ServiceHost::this_computer());
        let mut other = ServiceHost::agent("b");
        other.keep_if_absent(&stored);
        assert_eq!(other, ServiceHost::agent("b"));
    }
}

//! Unknown per-entry fields of a persisted list store (#3951, part of #2744).
//!
//! A list-shaped config store (embedded servers, WoL devices, HTTP monitors)
//! may be written by a newer build that added fields to an entry. An older
//! build must carry those fields through a load → save instead of dropping
//! them. Each entry type keeps them in a flattened [`EntryExtra`] map that is
//! skipped by ts-rs, so the generated TypeScript shape does not change.
//!
//! The same types are also the IPC shape. The editor's copy of an entry never
//! holds the on-disk unknown fields, and any unknown keys it does hold are
//! frontend state, not a newer build's data. So a save that replaces an entry
//! goes through [`upsert_keeping_extra`], which keeps the resident entry's
//! fields and drops the incoming copy's.

/// Unknown fields of one persisted entry, kept verbatim.
pub type EntryExtra = serde_json::Map<String, serde_json::Value>;

/// A persisted list-store entry with an id and an [`EntryExtra`] map.
pub trait StoreEntry {
    /// The entry's stable id, used to match an edited copy to its resident entry.
    fn entry_id(&self) -> &str;
    /// The entry's unknown on-disk fields.
    fn entry_extra_mut(&mut self) -> &mut EntryExtra;
}

/// Replace the entry with `incoming`'s id, or append `incoming` when there is
/// none.
///
/// The stored entry keeps the unknown fields the resident entry had. The
/// incoming copy's own unknown fields are discarded: they came over IPC, so
/// they are frontend state and never belong on disk.
pub fn upsert_keeping_extra<T: StoreEntry>(entries: &mut Vec<T>, mut incoming: T) {
    let resident = entries
        .iter_mut()
        .find(|entry| entry.entry_id() == incoming.entry_id());
    match resident {
        Some(existing) => {
            *incoming.entry_extra_mut() = std::mem::take(existing.entry_extra_mut());
            *existing = incoming;
        }
        None => {
            incoming.entry_extra_mut().clear();
            entries.push(incoming);
        }
    }
}

/// A copy of `entry` without its unknown fields, for a wire that is not the
/// desktop's own file (e.g. an agent RPC).
pub fn without_extra<T: StoreEntry + Clone>(entry: &T) -> T {
    let mut copy = entry.clone();
    copy.entry_extra_mut().clear();
    copy
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(Clone, Debug, PartialEq)]
    struct Item {
        id: &'static str,
        value: u32,
        extra: EntryExtra,
    }

    impl StoreEntry for Item {
        fn entry_id(&self) -> &str {
            self.id
        }
        fn entry_extra_mut(&mut self) -> &mut EntryExtra {
            &mut self.extra
        }
    }

    fn item(id: &'static str, value: u32, extra: serde_json::Value) -> Item {
        Item {
            id,
            value,
            extra: extra.as_object().cloned().unwrap_or_default(),
        }
    }

    #[test]
    fn replacing_keeps_the_resident_extra_and_drops_the_incoming_one() {
        let mut entries = vec![item("a", 1, json!({"disk": 1})), item("b", 2, json!({}))];
        upsert_keeping_extra(&mut entries, item("a", 9, json!({"ipc": 1})));
        assert_eq!(entries[0], item("a", 9, json!({"disk": 1})));
        assert_eq!(entries[1], item("b", 2, json!({})));
    }

    #[test]
    fn appending_drops_the_incoming_extra() {
        let mut entries = vec![item("a", 1, json!({"disk": 1}))];
        upsert_keeping_extra(&mut entries, item("c", 3, json!({"ipc": 1})));
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1], item("c", 3, json!({})));
        assert_eq!(entries[0], item("a", 1, json!({"disk": 1})));
    }

    #[test]
    fn without_extra_clears_only_the_copy() {
        let original = item("a", 1, json!({"disk": 1}));
        assert_eq!(without_extra(&original), item("a", 1, json!({})));
        assert_eq!(original.extra.len(), 1);
    }
}

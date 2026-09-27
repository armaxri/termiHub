//! Connection id ↔ name maps for portable workspace export/import (#3625).
//!
//! A workspace tab binds a saved connection by id. Exported workspaces carry the
//! connection's **name** instead (ids are local tree paths), and importing maps
//! the name back to an id. Both maps are built from the unified connection view —
//! the main store plus every enabled external connection file — the same set
//! every other by-reference lookup resolves against.
//!
//! Lookups follow the one rule of [`match_unique`](crate::connection::jump_host_resolver::match_unique)
//! (#3602): a key held by exactly one connection maps, a key held by several is
//! **ambiguous** and left unmapped with a warning. Nothing is ever guessed: an
//! ambiguous id is exported verbatim (without a portable name) and an ambiguous
//! name is imported verbatim (not bound to any of its candidates).

use std::collections::HashMap;

use crate::connection::config::SavedConnection;
use crate::connection::jump_host_resolver::{match_unique, source_labels, UniqueMatch};

/// A one-directional connection reference map (id → name for export, name → id
/// for import) that also remembers which keys were ambiguous.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConnectionRefMap {
    /// Keys held by exactly one connection, mapped to the other side.
    mapped: HashMap<String, String>,
    /// Keys held by several connections, with a phrase naming where they live.
    ambiguous: HashMap<String, String>,
}

/// How a single reference resolved through a [`ConnectionRefMap`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefLookup<'a> {
    /// The key maps to exactly one value.
    Mapped(&'a str),
    /// The key matches several connections; `sources` names their files.
    Ambiguous { sources: &'a str },
    /// No connection holds the key.
    Unknown,
}

impl ConnectionRefMap {
    /// The id → name map used by export.
    pub fn for_export(connections: &[SavedConnection]) -> Self {
        Self::build(connections, |c| &c.id, |c| &c.name)
    }

    /// The name → id map used by import.
    pub fn for_import(connections: &[SavedConnection]) -> Self {
        Self::build(connections, |c| &c.name, |c| &c.id)
    }

    fn build(
        connections: &[SavedConnection],
        key: impl Fn(&SavedConnection) -> &String,
        value: impl Fn(&SavedConnection) -> &String,
    ) -> Self {
        let mut map = Self::default();
        for conn in connections {
            let k = key(conn);
            if map.mapped.contains_key(k) || map.ambiguous.contains_key(k) {
                continue;
            }
            match match_unique(connections, |c| key(c) == k) {
                UniqueMatch::One(c) => {
                    map.mapped.insert(k.clone(), value(c).clone());
                }
                UniqueMatch::Ambiguous(all) => {
                    map.ambiguous.insert(k.clone(), source_labels(&all));
                }
                UniqueMatch::None => {}
            }
        }
        map
    }

    /// Resolve `key` under the unique-match rule.
    pub fn lookup(&self, key: &str) -> RefLookup<'_> {
        if let Some(v) = self.mapped.get(key) {
            RefLookup::Mapped(v)
        } else if let Some(sources) = self.ambiguous.get(key) {
            RefLookup::Ambiguous { sources }
        } else {
            RefLookup::Unknown
        }
    }
}

/// A plain map with no ambiguous keys (every entry resolves).
impl From<HashMap<String, String>> for ConnectionRefMap {
    fn from(mapped: HashMap<String, String>) -> Self {
        Self {
            mapped,
            ambiguous: HashMap::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::backend::ConnectionConfig;

    fn conn(id: &str, name: &str, source: Option<&str>) -> SavedConnection {
        SavedConnection {
            id: id.to_string(),
            name: name.to_string(),
            config: ConnectionConfig {
                type_id: "ssh".to_string(),
                settings: serde_json::json!({}),
            },
            folder_id: None,
            terminal_options: None,
            icon: None,
            source_file: source.map(str::to_string),
        }
    }

    #[test]
    fn unique_ids_and_names_map_across_files() {
        let conns = vec![
            conn("Main", "Main", None),
            conn("Team/Web", "Web", Some("/ext/team.json")),
        ];
        let export = ConnectionRefMap::for_export(&conns);
        assert_eq!(export.lookup("Team/Web"), RefLookup::Mapped("Web"));
        assert_eq!(export.lookup("Main"), RefLookup::Mapped("Main"));
        assert_eq!(export.lookup("Gone"), RefLookup::Unknown);

        let import = ConnectionRefMap::for_import(&conns);
        assert_eq!(import.lookup("Web"), RefLookup::Mapped("Team/Web"));
    }

    #[test]
    fn id_in_two_files_is_ambiguous_for_export() {
        let conns = vec![
            conn("Web", "Web", None),
            conn("Web", "Web", Some("/ext/team.json")),
        ];
        let export = ConnectionRefMap::for_export(&conns);
        match export.lookup("Web") {
            RefLookup::Ambiguous { sources } => {
                assert!(sources.contains("main connection store"), "{sources}");
                assert!(sources.contains("/ext/team.json"), "{sources}");
            }
            other => panic!("expected ambiguous, got {other:?}"),
        }
    }

    #[test]
    fn name_held_by_several_connections_is_ambiguous_for_import() {
        let conns = vec![
            conn("A/Web", "Web", None),
            conn("B/Web", "Web", Some("/ext/team.json")),
            conn("Other", "Other", None),
        ];
        let import = ConnectionRefMap::for_import(&conns);
        assert!(matches!(import.lookup("Web"), RefLookup::Ambiguous { .. }));
        assert_eq!(import.lookup("Other"), RefLookup::Mapped("Other"));
        // The ids themselves are unique, so export still names them.
        let export = ConnectionRefMap::for_export(&conns);
        assert_eq!(export.lookup("A/Web"), RefLookup::Mapped("Web"));
    }
}

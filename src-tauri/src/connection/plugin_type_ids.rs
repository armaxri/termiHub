//! Load-time migration of legacy plugin connection-type ids (PLG-007).
//!
//! Plugin connection types used to register under a load-order-dependent id —
//! the bare declared `connectionType` for the first registrant, `<type>-<plugin>`
//! (or `<type>-<plugin>-<n>`) for later colliders. They now register under the
//! stable `plugin:<plugin-id>:<connectionType>` (see
//! [`termihub_core::connection::plugin_type_id`]). Every store that persists a
//! connection-type id runs its loaded data through this module so a legacy id is
//! rewritten to the namespaced one:
//!
//! * `connections.json` — each saved connection's `config.type` (the schema
//!   version bump v2 → v3 marks files carrying namespaced ids, so an older build
//!   refuses to overwrite them — the existing downgrade-safety gate),
//! * `session-history.json` — each entry's `connectionType` and `config.type`,
//! * `workspaces.json` / `last-session.json` — each tab's `inlineConfig.type`,
//! * external connection files — each connection's `config.type`, persisted
//!   back to the file when rewritten (#3343),
//! * connection imports (plain and encrypted) and workspace imports — resolved
//!   before the imported records are merged into the store (#3343).
//!
//! Resolution needs the installed plugins (read from their manifests under
//! `<config-dir>/plugins/`, no library is loaded), so it runs as a post-load
//! pass rather than inside the pure JSON [`VersionedStore::migrate`] step. It is
//! idempotent and runs on every load: an id whose plugin is not installed is
//! **kept unchanged** (the connection is never dropped) and heals on a later
//! load once the plugin is installed. An id several installed plugins could have
//! produced resolves deterministically and is logged.
//!
//! [`VersionedStore::migrate`]: crate::utils::migrate::VersionedStore::migrate

use std::path::Path;

use serde_json::Value;
use termihub_core::connection::{LegacyResolution, LegacyTypeIdResolver};

use super::config::SavedConnection;
use crate::workspace::config::{WorkspaceLayoutNode, WorkspaceTabGroupDef};

/// Every connection-type id a termiHub build can register or persist itself,
/// across all platforms and cargo features. A bare id in this list is never a
/// plugin's, so it is never rewritten. (A test keeps it a superset of
/// [`crate::session::registry::build_desktop_registry`].)
pub const KNOWN_BUILTIN_TYPE_IDS: &[&str] = &[
    "local",
    "serial",
    "ssh",
    "telnet",
    "docker",
    "wsl",
    "ftp",
    "mock-remote-desktop",
    "vnc",
    "rdp",
    "remote",
    "remote-session",
];

/// Build the legacy-id resolver for the config directory `config_dir`, from the
/// manifests of the plugins installed under `<config_dir>/plugins/`.
pub fn legacy_resolver(config_dir: &Path) -> LegacyTypeIdResolver {
    LegacyTypeIdResolver::new(
        termihub_core::plugin::installed_backend_types(&config_dir.join("plugins")),
        KNOWN_BUILTIN_TYPE_IDS.iter().copied(),
    )
}

/// Build the legacy-id resolver for the config directory holding the store file
/// `store_file` (its parent directory). `None` when the path has no parent.
///
/// Used by every entry point that reads connection configs from outside the
/// four PLG-007 stores — external connection files, connection imports and
/// workspace imports (#3343) — so they resolve against the same installed
/// plugins as `connections.json`.
pub fn legacy_resolver_beside(store_file: &Path) -> Option<LegacyTypeIdResolver> {
    store_file.parent().map(legacy_resolver)
}

/// Resolve one persisted type id in place. Returns `true` when it was rewritten.
///
/// `what` names the owning record for the log line (e.g. `connection "Prod"`).
pub fn migrate_type_id(type_id: &mut String, resolver: &LegacyTypeIdResolver, what: &str) -> bool {
    match resolver.resolve(type_id) {
        LegacyResolution::Current => false,
        LegacyResolution::Resolved(new_id) => {
            tracing::info!("Migrated {what} connection type '{type_id}' -> '{new_id}' (PLG-007)");
            *type_id = new_id;
            true
        }
        LegacyResolution::Ambiguous {
            resolved,
            candidates,
        } => {
            tracing::warn!(
                "Legacy plugin connection type '{type_id}' of {what} is ambiguous between \
                 {candidates:?}; resolved to '{resolved}' (PLG-007)"
            );
            *type_id = resolved;
            true
        }
        LegacyResolution::Missing => {
            tracing::warn!(
                "{what} references connection type '{type_id}', which no installed plugin \
                 provides; keeping it unchanged until the plugin is installed"
            );
            false
        }
    }
}

/// Resolve the `type` of a `{ "type": …, "config": … }` connection-config JSON
/// value in place (session history, workspace inline configs). Anything else is
/// left untouched. Returns `true` when it was rewritten.
pub fn migrate_config_value(
    value: &mut Value,
    resolver: &LegacyTypeIdResolver,
    what: &str,
) -> bool {
    let Some(obj) = value.as_object_mut() else {
        return false;
    };
    if !obj.get("config").is_some_and(Value::is_object) {
        return false;
    }
    let Some(Value::String(type_id)) = obj.get_mut("type") else {
        return false;
    };
    migrate_type_id(type_id, resolver, what)
}

/// Resolve every saved connection's type id. Returns `true` if any changed.
pub fn migrate_connections(
    connections: &mut [SavedConnection],
    resolver: &LegacyTypeIdResolver,
) -> bool {
    let mut changed = false;
    for conn in connections {
        let what = format!("connection \"{}\"", conn.name);
        changed |= migrate_type_id(&mut conn.config.type_id, resolver, &what);
    }
    changed
}

/// Resolve every tab's inline connection config in a set of tab groups
/// (workspaces and the last session). Returns `true` if any changed.
pub fn migrate_tab_groups(
    groups: &mut [WorkspaceTabGroupDef],
    resolver: &LegacyTypeIdResolver,
    what: &str,
) -> bool {
    groups.iter_mut().fold(false, |changed, g| {
        migrate_layout(&mut g.layout, resolver, what) | changed
    })
}

fn migrate_layout(
    node: &mut WorkspaceLayoutNode,
    resolver: &LegacyTypeIdResolver,
    what: &str,
) -> bool {
    match node {
        WorkspaceLayoutNode::Leaf { tabs } => tabs.iter_mut().fold(false, |changed, tab| {
            let migrated = tab
                .inline_config
                .as_mut()
                .is_some_and(|cfg| migrate_config_value(cfg, resolver, what));
            migrated | changed
        }),
        WorkspaceLayoutNode::Split { children, .. } => {
            children.iter_mut().fold(false, |changed, c| {
                migrate_layout(c, resolver, what) | changed
            })
        }
    }
}

/// Test helper: install a minimal terminal-backend plugin manifest for
/// `plugin_id` declaring `connection_type` under `<config_dir>/plugins/`.
#[cfg(test)]
pub(crate) fn write_backend_plugin_manifest(
    config_dir: &Path,
    plugin_id: &str,
    connection_type: &str,
) {
    let dir = config_dir.join("plugins").join(plugin_id);
    std::fs::create_dir_all(&dir).unwrap();
    let manifest = serde_json::json!({
        "id": plugin_id,
        "name": plugin_id,
        "version": "1.0.0",
        "author": "tester",
        "description": "test plugin",
        "license": "MIT",
        "apiVersion": "1.0",
        "platforms": ["linux", "macos", "windows"],
        "permissions": ["terminal"],
        "extensions": {
            "terminalBackend": {
                "connectionType": connection_type,
                "displayName": connection_type,
                "configSchema": {}
            }
        }
    });
    std::fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::backend::ConnectionConfig;
    use crate::workspace::config::WorkspaceTabDef;
    use serde_json::json;

    fn resolver(plugins: &[(&str, &str)]) -> LegacyTypeIdResolver {
        LegacyTypeIdResolver::new(
            plugins
                .iter()
                .map(|(p, c)| ((*p).to_string(), (*c).to_string())),
            KNOWN_BUILTIN_TYPE_IDS.iter().copied(),
        )
    }

    fn conn(name: &str, type_id: &str) -> SavedConnection {
        SavedConnection {
            id: name.to_string(),
            name: name.to_string(),
            config: ConnectionConfig {
                type_id: type_id.to_string(),
                settings: json!({}),
            },
            folder_id: None,
            terminal_options: None,
            icon: None,
            source_file: None,
        }
    }

    #[test]
    fn builtin_registry_ids_are_all_known_builtins() {
        let registry = crate::session::registry::build_desktop_registry();
        for info in registry.available_types() {
            assert!(
                KNOWN_BUILTIN_TYPE_IDS.contains(&info.type_id.as_str()),
                "built-in type '{}' is missing from KNOWN_BUILTIN_TYPE_IDS",
                info.type_id
            );
        }
    }

    #[test]
    fn migrates_legacy_connections_and_leaves_the_rest() {
        let r = resolver(&[("alpha", "k8s"), ("beta", "k8s"), ("gamma", "ssh")]);
        let mut conns = vec![
            conn("builtin", "ssh"),
            conn("namespaced", "plugin:beta:k8s"),
            conn("suffixed", "k8s-beta"),
            conn("builtin-collider", "ssh-gamma"),
            conn("ambiguous", "k8s"),
            conn("missing", "mqtt"),
        ];
        assert!(migrate_connections(&mut conns, &r));
        let types: Vec<&str> = conns.iter().map(|c| c.config.type_id.as_str()).collect();
        assert_eq!(
            types,
            [
                "ssh",
                "plugin:beta:k8s",
                "plugin:beta:k8s",
                "plugin:gamma:ssh",
                // Ambiguous plain id: the lowest plugin id got it at startup.
                "plugin:alpha:k8s",
                // Missing plugin: kept (never dropped), unchanged.
                "mqtt",
            ]
        );
        // Idempotent: a second pass changes nothing.
        assert!(!migrate_connections(&mut conns, &r));
    }

    #[test]
    fn migrates_only_connection_config_shaped_values() {
        let r = resolver(&[("beta", "k8s")]);
        let mut cfg = json!({ "type": "k8s", "config": { "pod": "p" } });
        assert!(migrate_config_value(&mut cfg, &r, "entry"));
        assert_eq!(cfg["type"], "plugin:beta:k8s");
        assert_eq!(cfg["config"]["pod"], "p");

        // A layout node or a type without a config object is not a connection.
        let mut leaf = json!({ "type": "k8s", "tabs": [] });
        assert!(!migrate_config_value(&mut leaf, &r, "entry"));
        assert_eq!(leaf["type"], "k8s");
    }

    #[test]
    fn migrates_nested_tab_inline_configs() {
        let r = resolver(&[("beta", "k8s")]);
        let tab = |cfg: Option<Value>| WorkspaceTabDef {
            connection_ref: None,
            inline_config: cfg,
            agent_ref: None,
            title: None,
            initial_command: None,
        };
        let mut groups = vec![WorkspaceTabGroupDef {
            name: "Main".into(),
            color: None,
            window_id: None,
            layout: WorkspaceLayoutNode::Split {
                direction: crate::workspace::config::SplitDirection::Horizontal,
                sizes: None,
                children: vec![
                    WorkspaceLayoutNode::Leaf {
                        tabs: vec![tab(Some(json!({ "type": "k8s", "config": {} }))), tab(None)],
                    },
                    WorkspaceLayoutNode::Leaf {
                        tabs: vec![tab(Some(json!({ "type": "local", "config": {} })))],
                    },
                ],
            },
        }];
        assert!(migrate_tab_groups(&mut groups, &r, "workspace"));
        let WorkspaceLayoutNode::Split { children, .. } = &groups[0].layout else {
            panic!("split expected");
        };
        let WorkspaceLayoutNode::Leaf { tabs } = &children[0] else {
            panic!("leaf expected");
        };
        assert_eq!(
            tabs[0].inline_config.as_ref().unwrap()["type"],
            "plugin:beta:k8s"
        );
        let WorkspaceLayoutNode::Leaf { tabs } = &children[1] else {
            panic!("leaf expected");
        };
        assert_eq!(tabs[0].inline_config.as_ref().unwrap()["type"], "local");
    }

    #[test]
    fn resolver_reads_installed_plugin_manifests() {
        let dir = tempfile::TempDir::new().unwrap();
        write_backend_plugin_manifest(dir.path(), "beta", "k8s");
        let r = legacy_resolver(dir.path());
        assert_eq!(
            r.resolve("k8s"),
            LegacyResolution::Resolved("plugin:beta:k8s".into())
        );
        assert_eq!(r.resolve("ssh"), LegacyResolution::Current);
    }
}

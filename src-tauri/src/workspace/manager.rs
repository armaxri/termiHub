use std::sync::Mutex;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::{
    count_tabs, follow_connection_id_changes_in_groups, WorkspaceDefinition, WorkspaceExportData,
    WorkspaceExportEntry, WorkspaceExportResult, WorkspaceImportPreview, WorkspaceImportResult,
    WorkspaceLayoutNode, WorkspaceStore, WorkspaceSummary, WorkspaceTabDef, WorkspaceTabGroupDef,
};
use super::connection_refs::{ConnectionRefMap, RefLookup};
use super::settings::{ActiveWorkspaceInfo, WorkspaceSettings};
use super::storage::WorkspaceStorage;
use crate::connection::id_changes::ConnectionIdRemap;
use crate::connection::recovery::RecoveryWarning;
use crate::utils::errors::TerminalError;

/// Central workspace manager: CRUD for workspace definitions.
pub struct WorkspaceManager {
    store: Mutex<WorkspaceStore>,
    storage: WorkspaceStorage,
    recovery_warnings: Mutex<Vec<RecoveryWarning>>,
    /// Id of the workspace whose settings overrides are currently in effect
    /// (PROD-052). Set by the frontend when a workspace is launched/saved and
    /// cleared when it is deleted. Persisted in the last session (#3517), not
    /// here, and re-activated from it at startup.
    active_id: Mutex<Option<String>>,
}

/// Normalize a definition's settings overrides before storing: validate them
/// and drop an all-empty record so it is not persisted.
fn normalize_settings(definition: &mut WorkspaceDefinition) -> Result<(), TerminalError> {
    if let Some(settings) = &definition.settings {
        settings.validate().map_err(TerminalError::WorkspaceError)?;
        if settings.is_empty() {
            definition.settings = None;
        }
    }
    Ok(())
}

impl WorkspaceManager {
    /// Initialize from disk, with recovery on corruption.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let storage =
            WorkspaceStorage::new(app_handle).context("Failed to initialize workspace storage")?;
        let result = storage
            .load_with_recovery()
            .context("Failed to load workspaces")?;

        Ok(Self {
            store: Mutex::new(result.data),
            storage,
            recovery_warnings: Mutex::new(result.warnings),
            active_id: Mutex::new(None),
        })
    }

    /// A manager backed by a file in `dir`. Test-only; production uses `new()`.
    #[cfg(test)]
    pub(crate) fn new_for_test(dir: &std::path::Path) -> Self {
        let storage = WorkspaceStorage::new_test(dir);
        let store = storage
            .load_with_recovery()
            .map(|r| r.data)
            .unwrap_or_default();
        Self {
            store: Mutex::new(store),
            storage,
            recovery_warnings: Mutex::new(Vec::new()),
            active_id: Mutex::new(None),
        }
    }

    /// Mark `id` as the active workspace whose overrides apply to new sessions
    /// (`None` clears it). An unknown id is rejected.
    pub fn set_active_workspace(&self, id: Option<String>) -> Result<(), TerminalError> {
        if let Some(id) = &id {
            let store = self
                .store
                .lock()
                .map_err(|e| TerminalError::WorkspaceError(e.to_string()))?;
            if !store.workspaces.iter().any(|ws| &ws.id == id) {
                return Err(TerminalError::WorkspaceError(format!(
                    "Workspace not found: {id}"
                )));
            }
        }
        let mut active = self
            .active_id
            .lock()
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))?;
        *active = id;
        Ok(())
    }

    /// The active workspace (id, name, overrides), if one is active.
    pub fn active_workspace_info(&self) -> Option<ActiveWorkspaceInfo> {
        let active = self.active_id.lock().ok()?.clone()?;
        let store = self.store.lock().ok()?;
        store
            .workspaces
            .iter()
            .find(|ws| ws.id == active)
            .map(|ws| ActiveWorkspaceInfo {
                id: ws.id.clone(),
                name: ws.name.clone(),
                settings: ws.settings.clone(),
            })
    }

    /// Id of the active workspace, if one is active.
    pub fn active_id(&self) -> Option<String> {
        self.active_id.lock().ok()?.clone()
    }

    /// Whether `id` is the active workspace.
    pub fn is_active(&self, id: &str) -> bool {
        self.active_id
            .lock()
            .map(|a| a.as_deref() == Some(id))
            .unwrap_or(false)
    }

    /// The settings overrides of the active workspace, if one is active and it
    /// carries any. Read at session-creation time so an edit to the active
    /// workspace applies to the next new session without a relaunch.
    pub fn active_settings(&self) -> Option<WorkspaceSettings> {
        self.active_workspace_info()?.settings
    }

    /// Take ownership of any recovery warnings (only the first call returns them).
    pub fn take_recovery_warnings(&self) -> Vec<RecoveryWarning> {
        self.recovery_warnings
            .lock()
            .map(|mut w| std::mem::take(&mut *w))
            .unwrap_or_default()
    }

    /// Get workspace summaries for sidebar listing.
    pub fn get_workspaces(&self) -> Result<Vec<WorkspaceSummary>, TerminalError> {
        let store = self
            .store
            .lock()
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))?;
        Ok(store.workspaces.iter().map(|ws| ws.to_summary()).collect())
    }

    /// Load a full workspace definition by ID.
    pub fn load_workspace(&self, id: &str) -> Result<WorkspaceDefinition, TerminalError> {
        let store = self
            .store
            .lock()
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))?;
        store
            .workspaces
            .iter()
            .find(|ws| ws.id == id)
            .cloned()
            .ok_or_else(|| TerminalError::WorkspaceError(format!("Workspace not found: {id}")))
    }

    /// Save (add or update) a workspace definition.
    pub fn save_workspace(&self, mut definition: WorkspaceDefinition) -> Result<(), TerminalError> {
        normalize_settings(&mut definition)?;
        let mut store = self
            .store
            .lock()
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))?;

        if let Some(existing) = store
            .workspaces
            .iter_mut()
            .find(|ws| ws.id == definition.id)
        {
            *existing = definition;
        } else {
            store.workspaces.push(definition);
        }

        self.storage
            .save(&store)
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))
    }

    /// Re-point every saved workspace's `connectionRef`s along `remap` (#3596),
    /// persisting the store only when a reference changed. The write is atomic
    /// and the in-memory store is updated only after it succeeded, so a failure
    /// leaves memory and disk in agreement. Returns whether anything changed.
    pub fn follow_connection_id_changes(
        &self,
        remap: &ConnectionIdRemap,
    ) -> Result<bool, TerminalError> {
        let mut store = self
            .store
            .lock()
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))?;
        let mut next = store.clone();
        let changed = next.workspaces.iter_mut().fold(false, |changed, ws| {
            follow_connection_id_changes_in_groups(&mut ws.tab_groups, remap) | changed
        });
        if !changed {
            return Ok(false);
        }
        self.storage
            .save(&next)
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))?;
        *store = next;
        Ok(true)
    }

    /// Delete a workspace by ID.
    pub fn delete_workspace(&self, id: &str) -> Result<(), TerminalError> {
        let mut store = self
            .store
            .lock()
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))?;

        let len_before = store.workspaces.len();
        store.workspaces.retain(|ws| ws.id != id);

        if store.workspaces.len() == len_before {
            return Err(TerminalError::WorkspaceError(format!(
                "Workspace not found: {id}"
            )));
        }
        if let Ok(mut active) = self.active_id.lock() {
            if active.as_deref() == Some(id) {
                *active = None;
            }
        }

        self.storage
            .save(&store)
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))
    }

    /// Duplicate a workspace by ID, returning the new workspace's ID.
    pub fn duplicate_workspace(&self, id: &str) -> Result<String, TerminalError> {
        let mut store = self
            .store
            .lock()
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))?;

        let original = store
            .workspaces
            .iter()
            .find(|ws| ws.id == id)
            .cloned()
            .ok_or_else(|| TerminalError::WorkspaceError(format!("Workspace not found: {id}")))?;

        let new_id = format!(
            "ws-{}-{}",
            chrono::Utc::now().timestamp_millis(),
            &uuid::Uuid::new_v4().to_string()[..6]
        );

        let duplicate = WorkspaceDefinition {
            id: new_id.clone(),
            name: format!("Copy of {}", original.name),
            description: original.description,
            tab_groups: original.tab_groups,
            windows: original.windows,
            settings: original.settings,
        };

        store.workspaces.push(duplicate);

        self.storage
            .save(&store)
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))?;

        Ok(new_id)
    }

    /// Export all workspaces as portable JSON.
    /// Connection IDs are replaced with connection names for portability.
    ///
    /// An id that `id_to_name` marks ambiguous (held by several connection
    /// files, #3625) is exported verbatim — it has no portable name — and a
    /// warning naming the workspace and the colliding files is returned.
    pub fn export_json(
        &self,
        id_to_name: &ConnectionRefMap,
    ) -> Result<WorkspaceExportResult, TerminalError> {
        let store = self
            .store
            .lock()
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))?;

        let mut warnings: Vec<String> = Vec::new();
        let entries: Vec<WorkspaceExportEntry> = store
            .workspaces
            .iter()
            .map(|ws| {
                let mut ambiguous: Vec<(String, String)> = Vec::new();
                let entry = WorkspaceExportEntry {
                    name: ws.name.clone(),
                    description: ws.description.clone(),
                    tab_groups: ws
                        .tab_groups
                        .iter()
                        .map(|g| WorkspaceTabGroupDef {
                            name: g.name.clone(),
                            color: g.color.clone(),
                            layout: replace_connection_ids_with_names(
                                &g.layout,
                                id_to_name,
                                &mut ambiguous,
                            ),
                            window_id: g.window_id.clone(),
                        })
                        .collect(),
                    windows: ws.windows.clone(),
                    settings: ws.settings.clone(),
                };
                ambiguous.sort();
                ambiguous.dedup();
                for (id, sources) in ambiguous {
                    warnings.push(format!(
                        "Workspace \"{}\": connection \"{id}\" exists in {sources}, so it \
                         has no unambiguous name and was exported by id. Rename or move one \
                         of them and export again for a portable reference.",
                        ws.name
                    ));
                }
                entry
            })
            .collect();

        let export = WorkspaceExportData {
            version: "1".to_string(),
            workspaces: entries,
        };

        let json = serde_json::to_string_pretty(&export)
            .map_err(|e| TerminalError::WorkspaceError(format!("Failed to serialize: {e}")))?;
        Ok(WorkspaceExportResult { json, warnings })
    }

    /// Import workspaces from portable JSON.
    /// Connection names are resolved back to IDs. Skips workspaces whose
    /// name already exists.
    ///
    /// Returns a [`WorkspaceImportResult`] carrying the number of workspaces
    /// imported and any non-fatal warnings (e.g. dangling connection references,
    /// PER-009) so the caller can surface them to the user.
    ///
    /// A name that `name_to_id` marks ambiguous (several connections carry it,
    /// #3625) is never guessed: the tab keeps the raw name and a warning is
    /// returned, like a dangling reference.
    pub fn import_json(
        &self,
        json: &str,
        name_to_id: &ConnectionRefMap,
    ) -> Result<WorkspaceImportResult, TerminalError> {
        let data: WorkspaceExportData = serde_json::from_str(json)
            .map_err(|e| TerminalError::WorkspaceError(format!("Invalid import data: {e}")))?;

        let mut store = self
            .store
            .lock()
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))?;

        // Resolve legacy plugin connection-type ids in imported inline tab
        // configs (PLG-007, #3343), as the `workspaces.json` load pass does.
        let resolver = self.storage.legacy_type_resolver();

        let mut count = 0;
        let mut warnings: Vec<String> = Vec::new();
        for entry in data.workspaces {
            // Skip if a workspace with the same name already exists
            if store.workspaces.iter().any(|ws| ws.name == entry.name) {
                continue;
            }

            let new_id = format!(
                "ws-{}-{}",
                chrono::Utc::now().timestamp_millis(),
                &uuid::Uuid::new_v4().to_string()[..6]
            );

            let mut unresolved = UnresolvedRefs::default();
            let mut definition = WorkspaceDefinition {
                id: new_id,
                name: entry.name,
                description: entry.description,
                tab_groups: entry
                    .tab_groups
                    .into_iter()
                    .map(|g| WorkspaceTabGroupDef {
                        name: g.name,
                        color: g.color,
                        layout: resolve_connection_names_to_ids(
                            &g.layout,
                            name_to_id,
                            &mut unresolved,
                        ),
                        window_id: g.window_id,
                    })
                    .collect(),
                windows: entry.windows,
                settings: entry.settings,
            };
            if normalize_settings(&mut definition).is_err() {
                // An imported file is untrusted input: keep the layout, drop only
                // the invalid settings overrides, and tell the user (PROD-052).
                definition.settings = None;
                warnings.push(format!(
                    "Workspace \"{}\": its settings overrides were invalid and were not imported",
                    definition.name
                ));
            }
            if let Some(resolver) = &resolver {
                let what = format!("imported workspace \"{}\"", definition.name);
                crate::connection::plugin_type_ids::migrate_tab_groups(
                    &mut definition.tab_groups,
                    resolver,
                    &what,
                );
            }

            // Surface any dangling connection references instead of silently
            // keeping them (PER-009). The tab and its raw ref are preserved above;
            // here we record a warning (both into the recovery-warning list and
            // in the returned result) so the user learns the workspace is
            // partially broken. Never auto-delete the tab or the reference.
            let ws_warnings =
                record_dangling_ref_warnings(&definition.name, unresolved, &self.recovery_warnings);
            warnings.extend(ws_warnings);

            store.workspaces.push(definition);
            count += 1;
        }

        self.storage
            .save(&store)
            .map_err(|e| TerminalError::WorkspaceError(e.to_string()))?;

        Ok(WorkspaceImportResult {
            imported_count: count,
            warnings,
        })
    }

    /// Preview an import file without importing.
    pub fn preview_import_json(json: &str) -> Result<WorkspaceImportPreview, TerminalError> {
        let data: WorkspaceExportData = serde_json::from_str(json)
            .map_err(|e| TerminalError::WorkspaceError(format!("Invalid import data: {e}")))?;

        let total_tab_count = data
            .workspaces
            .iter()
            .flat_map(|ws| ws.tab_groups.iter())
            .map(|g| count_tabs(&g.layout))
            .sum();

        Ok(WorkspaceImportPreview {
            workspace_count: data.workspaces.len(),
            total_tab_count,
        })
    }
}

/// Record a recovery-style warning for each connection name that a workspace
/// referenced but that no longer resolves to a known connection (PER-009).
///
/// De-duplicates the names, logs each one (so it is visible at runtime), and
/// appends a [`RecoveryWarning`] to the manager's warning list — reusing the same
/// machinery that reports corrupt/recovered stores elsewhere. The referencing tab
/// is intentionally left untouched; this only surfaces the dangling reference.
///
/// Returns the human-readable warning messages so the import path can also hand
/// them back to the caller (and, ultimately, the UI) rather than only recording
/// them server-side.
fn record_dangling_ref_warnings(
    workspace_name: &str,
    unresolved: UnresolvedRefs,
    recovery_warnings: &Mutex<Vec<RecoveryWarning>>,
) -> Vec<String> {
    let UnresolvedRefs {
        mut missing,
        mut ambiguous,
    } = unresolved;
    if missing.is_empty() && ambiguous.is_empty() {
        return Vec::new();
    }
    missing.sort();
    missing.dedup();
    ambiguous.sort();
    ambiguous.dedup();

    let mut messages: Vec<String> = Vec::with_capacity(missing.len() + ambiguous.len());
    for name in missing.iter() {
        tracing::warn!(
            workspace = %workspace_name,
            connection = %name,
            "imported workspace references a connection that no longer exists; \
             the tab was kept but will not connect until the connection is restored"
        );
        messages.push(format!(
            "Workspace \"{workspace_name}\" references connection \"{name}\", \
             which no longer exists. The tab was kept but will not connect \
             until the connection is restored."
        ));
    }
    for (name, sources) in ambiguous.iter() {
        tracing::warn!(
            workspace = %workspace_name,
            connection = %name,
            "imported workspace references a connection name that several connections \
             carry; the tab was kept unlinked rather than guessing"
        );
        messages.push(format!(
            "Workspace \"{workspace_name}\" references connection \"{name}\", \
             which matches several connections (in {sources}). The tab was kept but \
             not linked to any of them; rename one so the name is unique and import \
             again, or re-bind the tab."
        ));
    }

    // Also record into the shared recovery-warning list (best-effort; a poisoned
    // lock must not drop the messages already destined for the caller).
    if let Ok(mut warnings) = recovery_warnings.lock() {
        for message in messages.iter() {
            warnings.push(RecoveryWarning {
                file_name: "workspaces.json".to_string(),
                message: message.clone(),
                details: None,
            });
        }
    }

    messages
}

/// Connection references an import could not bind to an id.
#[derive(Debug, Default)]
struct UnresolvedRefs {
    /// Names no connection carries (PER-009).
    missing: Vec<String>,
    /// Names several connections carry, with the files they live in (#3625).
    ambiguous: Vec<(String, String)>,
}

/// Replace connection ref IDs with connection names for export.
///
/// An unknown id is kept verbatim. An ambiguous id is kept verbatim too and
/// recorded in `ambiguous` (with the colliding files) so the export can warn.
fn replace_connection_ids_with_names(
    layout: &WorkspaceLayoutNode,
    id_to_name: &ConnectionRefMap,
    ambiguous: &mut Vec<(String, String)>,
) -> WorkspaceLayoutNode {
    match layout {
        WorkspaceLayoutNode::Leaf { tabs } => WorkspaceLayoutNode::Leaf {
            tabs: tabs
                .iter()
                .map(|tab| WorkspaceTabDef {
                    connection_ref: tab.connection_ref.as_ref().map(|id| {
                        match id_to_name.lookup(id) {
                            RefLookup::Mapped(name) => name.to_string(),
                            RefLookup::Ambiguous { sources } => {
                                ambiguous.push((id.clone(), sources.to_string()));
                                id.clone()
                            }
                            RefLookup::Unknown => id.clone(),
                        }
                    }),
                    ..tab.clone()
                })
                .collect(),
        },
        WorkspaceLayoutNode::Split {
            direction,
            children,
            sizes,
        } => WorkspaceLayoutNode::Split {
            direction: direction.clone(),
            children: children
                .iter()
                .map(|c| replace_connection_ids_with_names(c, id_to_name, ambiguous))
                .collect(),
            sizes: sizes.clone(),
        },
    }
}

/// Resolve connection names back to IDs for import.
///
/// A name that does not resolve to a known connection is **kept verbatim** (no
/// data is dropped) and its name is recorded in `unresolved` so the caller can
/// surface a warning instead of silently swallowing the dangling reference
/// (PER-009). A name several connections carry is kept verbatim the same way
/// and recorded as ambiguous — never bound to one of them (#3625).
fn resolve_connection_names_to_ids(
    layout: &WorkspaceLayoutNode,
    name_to_id: &ConnectionRefMap,
    unresolved: &mut UnresolvedRefs,
) -> WorkspaceLayoutNode {
    match layout {
        WorkspaceLayoutNode::Leaf { tabs } => WorkspaceLayoutNode::Leaf {
            tabs: tabs
                .iter()
                .map(|tab| WorkspaceTabDef {
                    connection_ref: tab.connection_ref.as_ref().map(|name| {
                        match name_to_id.lookup(name) {
                            RefLookup::Mapped(id) => id.to_string(),
                            // Preserve the raw name — the tab is never dropped —
                            // but record it so the import can warn about it.
                            RefLookup::Ambiguous { sources } => {
                                unresolved
                                    .ambiguous
                                    .push((name.clone(), sources.to_string()));
                                name.clone()
                            }
                            RefLookup::Unknown => {
                                unresolved.missing.push(name.clone());
                                name.clone()
                            }
                        }
                    }),
                    ..tab.clone()
                })
                .collect(),
        },
        WorkspaceLayoutNode::Split {
            direction,
            children,
            sizes,
        } => WorkspaceLayoutNode::Split {
            direction: direction.clone(),
            children: children
                .iter()
                .map(|c| resolve_connection_names_to_ids(c, name_to_id, unresolved))
                .collect(),
            sizes: sizes.clone(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::config::{SplitDirection, WorkspaceLayoutNode, WorkspaceTabDef};
    use crate::workspace::storage::WorkspaceStorage;
    use std::collections::HashMap;
    use tempfile::TempDir;

    fn create_test_manager(dir: &TempDir) -> WorkspaceManager {
        let storage = WorkspaceStorage::new_test(dir.path());
        let store = WorkspaceStore::default();
        WorkspaceManager {
            store: Mutex::new(store),
            storage,
            recovery_warnings: Mutex::new(Vec::new()),
            active_id: Mutex::new(None),
        }
    }

    fn with_settings(
        mut def: WorkspaceDefinition,
        settings: WorkspaceSettings,
    ) -> WorkspaceDefinition {
        def.settings = Some(settings);
        def
    }

    fn env(key: &str, value: &str) -> crate::workspace::settings::WorkspaceEnvVar {
        crate::workspace::settings::WorkspaceEnvVar {
            key: key.to_string(),
            value: value.to_string(),
        }
    }

    #[test]
    fn save_rejects_invalid_settings() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);
        let def = with_settings(
            sample_definition("ws-1", "Bad"),
            WorkspaceSettings {
                env_vars: vec![env("1BAD", "x")],
                ..Default::default()
            },
        );
        assert!(mgr.save_workspace(def).is_err());
        assert!(mgr.get_workspaces().unwrap().is_empty());
    }

    #[test]
    fn save_drops_empty_settings_record() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);
        let def = with_settings(
            sample_definition("ws-1", "Empty"),
            WorkspaceSettings::default(),
        );
        mgr.save_workspace(def).unwrap();
        assert!(mgr.load_workspace("ws-1").unwrap().settings.is_none());
    }

    #[test]
    fn active_settings_follow_active_workspace() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);
        let settings = WorkspaceSettings {
            default_working_directory: Some("/srv".into()),
            ..Default::default()
        };
        mgr.save_workspace(with_settings(
            sample_definition("ws-1", "A"),
            settings.clone(),
        ))
        .unwrap();
        mgr.save_workspace(sample_definition("ws-2", "B")).unwrap();

        assert!(mgr.active_settings().is_none(), "nothing active initially");
        mgr.set_active_workspace(Some("ws-1".into())).unwrap();
        assert_eq!(mgr.active_settings(), Some(settings));

        // Editing the active workspace is seen by the next lookup (no relaunch).
        let edited = WorkspaceSettings {
            default_working_directory: Some("/other".into()),
            ..Default::default()
        };
        mgr.save_workspace(with_settings(
            sample_definition("ws-1", "A"),
            edited.clone(),
        ))
        .unwrap();
        assert_eq!(mgr.active_settings(), Some(edited));

        // Switching to a workspace without overrides yields none.
        mgr.set_active_workspace(Some("ws-2".into())).unwrap();
        assert!(mgr.active_settings().is_none());

        let info = mgr.active_workspace_info().unwrap();
        assert_eq!((info.id.as_str(), info.name.as_str()), ("ws-2", "B"));
        assert!(mgr.is_active("ws-2") && !mgr.is_active("ws-1"));

        assert!(mgr.set_active_workspace(Some("missing".into())).is_err());
        mgr.set_active_workspace(None).unwrap();
        assert!(mgr.active_settings().is_none());
    }

    #[test]
    fn deleting_active_workspace_clears_it() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);
        let settings = WorkspaceSettings {
            theme: Some("light".into()),
            ..Default::default()
        };
        mgr.save_workspace(with_settings(sample_definition("ws-1", "A"), settings))
            .unwrap();
        mgr.set_active_workspace(Some("ws-1".into())).unwrap();
        mgr.delete_workspace("ws-1").unwrap();
        assert!(mgr.active_settings().is_none());
        assert_eq!(mgr.active_id(), None);
    }

    /// #3517: the active workspace is tracked by id, so renaming it keeps it
    /// active (and the broadcast info carries the new name), and a missing id
    /// — e.g. one recorded by a previous run — is rejected, leaving none active.
    #[test]
    fn active_id_survives_rename_and_rejects_missing() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);
        mgr.save_workspace(sample_definition("ws-1", "A")).unwrap();
        mgr.set_active_workspace(Some("ws-1".into())).unwrap();
        mgr.save_workspace(sample_definition("ws-1", "Renamed"))
            .unwrap();
        assert_eq!(mgr.active_id().as_deref(), Some("ws-1"));
        assert_eq!(mgr.active_workspace_info().unwrap().name, "Renamed");

        let fresh = create_test_manager(&dir);
        assert_eq!(fresh.active_id(), None, "not persisted in workspaces.json");
        assert!(fresh.set_active_workspace(Some("gone".into())).is_err());
        assert_eq!(fresh.active_id(), None);
    }

    #[test]
    fn settings_survive_duplicate_and_export_import() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);
        let settings = WorkspaceSettings {
            theme: Some("light".into()),
            env_vars: vec![env("STAGE", "dev")],
            ..Default::default()
        };
        mgr.save_workspace(with_settings(
            sample_definition("ws-1", "A"),
            settings.clone(),
        ))
        .unwrap();
        let dup = mgr.duplicate_workspace("ws-1").unwrap();
        assert_eq!(
            mgr.load_workspace(&dup).unwrap().settings,
            Some(settings.clone())
        );

        let json = mgr.export_json(&ConnectionRefMap::default()).unwrap().json;
        let dir2 = TempDir::new().unwrap();
        let mgr2 = create_test_manager(&dir2);
        let result = mgr2
            .import_json(&json, &ConnectionRefMap::default())
            .unwrap();
        assert_eq!(result.imported_count, 2);
        let imported = mgr2.get_workspaces().unwrap();
        let first = mgr2.load_workspace(&imported[0].id).unwrap();
        assert_eq!(first.settings, Some(settings));
    }

    #[test]
    fn import_drops_invalid_settings_with_warning() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);
        let json = serde_json::json!({
            "version": "1",
            "workspaces": [{
                "name": "Imported",
                "tabGroups": [{ "name": "Main", "layout": { "type": "leaf", "tabs": [] } }],
                "settings": { "envVars": [{ "key": "NOT VALID", "value": "x" }] }
            }]
        })
        .to_string();
        let result = mgr
            .import_json(&json, &ConnectionRefMap::default())
            .unwrap();
        assert_eq!(result.imported_count, 1);
        assert!(result
            .warnings
            .iter()
            .any(|w| w.contains("settings overrides")));
        let id = mgr.get_workspaces().unwrap()[0].id.clone();
        assert!(mgr.load_workspace(&id).unwrap().settings.is_none());
    }

    fn sample_definition(id: &str, name: &str) -> WorkspaceDefinition {
        WorkspaceDefinition {
            id: id.to_string(),
            name: name.to_string(),
            description: None,
            windows: None,
            settings: None,
            tab_groups: vec![WorkspaceTabGroupDef {
                name: "Main".to_string(),
                color: None,
                window_id: None,
                layout: WorkspaceLayoutNode::Leaf {
                    tabs: vec![WorkspaceTabDef {
                        connection_ref: Some("conn-1".to_string()),
                        inline_config: None,
                        agent_ref: None,
                        title: None,
                        initial_command: None,
                    }],
                },
            }],
        }
    }

    fn multi_group_definition(id: &str, name: &str) -> WorkspaceDefinition {
        WorkspaceDefinition {
            id: id.to_string(),
            name: name.to_string(),
            description: None,
            windows: None,
            settings: None,
            tab_groups: vec![
                WorkspaceTabGroupDef {
                    name: "Dev".to_string(),
                    color: None,
                    window_id: None,
                    layout: WorkspaceLayoutNode::Leaf {
                        tabs: vec![WorkspaceTabDef {
                            connection_ref: Some("conn-1".to_string()),
                            inline_config: None,
                            agent_ref: None,
                            title: None,
                            initial_command: None,
                        }],
                    },
                },
                WorkspaceTabGroupDef {
                    name: "Deploy".to_string(),
                    color: Some("#ff6b6b".to_string()),
                    window_id: None,
                    layout: WorkspaceLayoutNode::Leaf {
                        tabs: vec![WorkspaceTabDef {
                            connection_ref: Some("conn-2".to_string()),
                            inline_config: None,
                            agent_ref: None,
                            title: None,
                            initial_command: None,
                        }],
                    },
                },
            ],
        }
    }

    #[test]
    fn get_workspaces_empty() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);
        let workspaces = mgr.get_workspaces().unwrap();
        assert!(workspaces.is_empty());
    }

    #[test]
    fn save_and_get_workspaces() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_workspace(sample_definition("ws-1", "First"))
            .unwrap();
        mgr.save_workspace(sample_definition("ws-2", "Second"))
            .unwrap();

        let workspaces = mgr.get_workspaces().unwrap();
        assert_eq!(workspaces.len(), 2);
        assert_eq!(workspaces[0].name, "First");
        assert_eq!(workspaces[1].name, "Second");
    }

    #[test]
    fn save_workspace_update() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_workspace(sample_definition("ws-1", "Original"))
            .unwrap();
        mgr.save_workspace(sample_definition("ws-1", "Updated"))
            .unwrap();

        let workspaces = mgr.get_workspaces().unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].name, "Updated");
    }

    #[test]
    fn load_workspace() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        let ws = WorkspaceDefinition {
            id: "ws-1".to_string(),
            name: "Test".to_string(),
            description: Some("desc".to_string()),
            windows: None,
            settings: None,
            tab_groups: vec![WorkspaceTabGroupDef {
                name: "Main".to_string(),
                color: None,
                window_id: None,
                layout: WorkspaceLayoutNode::Split {
                    direction: SplitDirection::Horizontal,
                    children: vec![
                        WorkspaceLayoutNode::Leaf {
                            tabs: vec![WorkspaceTabDef {
                                connection_ref: Some("conn-1".to_string()),
                                inline_config: None,
                                agent_ref: None,
                                title: None,
                                initial_command: None,
                            }],
                        },
                        WorkspaceLayoutNode::Leaf {
                            tabs: vec![WorkspaceTabDef {
                                connection_ref: Some("conn-2".to_string()),
                                inline_config: None,
                                agent_ref: None,
                                title: None,
                                initial_command: None,
                            }],
                        },
                    ],
                    sizes: None,
                },
            }],
        };
        mgr.save_workspace(ws).unwrap();

        let loaded = mgr.load_workspace("ws-1").unwrap();
        assert_eq!(loaded.name, "Test");
        assert_eq!(loaded.description.as_deref(), Some("desc"));
        assert_eq!(loaded.tab_groups.len(), 1);
        assert_eq!(loaded.tab_groups[0].name, "Main");
    }

    #[test]
    fn load_workspace_not_found() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);
        let result = mgr.load_workspace("nonexistent");
        assert!(result.is_err());
    }

    #[test]
    fn delete_workspace() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_workspace(sample_definition("ws-1", "Test"))
            .unwrap();
        mgr.delete_workspace("ws-1").unwrap();

        let workspaces = mgr.get_workspaces().unwrap();
        assert!(workspaces.is_empty());
    }

    #[test]
    fn delete_workspace_not_found() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);
        let result = mgr.delete_workspace("nonexistent");
        assert!(result.is_err());
    }

    #[test]
    fn duplicate_workspace() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_workspace(multi_group_definition("ws-1", "Original"))
            .unwrap();
        let new_id = mgr.duplicate_workspace("ws-1").unwrap();

        let workspaces = mgr.get_workspaces().unwrap();
        assert_eq!(workspaces.len(), 2);

        let dup = mgr.load_workspace(&new_id).unwrap();
        assert_eq!(dup.name, "Copy of Original");
        assert_eq!(dup.tab_groups.len(), 2);
        assert_eq!(dup.tab_groups[0].name, "Dev");
        assert_eq!(dup.tab_groups[1].name, "Deploy");
        assert_eq!(dup.tab_groups[1].color.as_deref(), Some("#ff6b6b"));
    }

    #[test]
    fn duplicate_workspace_not_found() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);
        let result = mgr.duplicate_workspace("nonexistent");
        assert!(result.is_err());
    }

    #[test]
    fn window_dimension_survives_duplicate_and_export_import() {
        use crate::workspace::config::WorkspaceWindowDef;

        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        // A multi-window layout: the second group lives in win-1.
        let mut def = multi_group_definition("ws-1", "Multi Window");
        def.tab_groups[1].window_id = Some("win-1".to_string());
        def.windows = Some(vec![
            WorkspaceWindowDef {
                id: "main".to_string(),
            },
            WorkspaceWindowDef {
                id: "win-1".to_string(),
            },
        ]);
        mgr.save_workspace(def).unwrap();

        // Duplicate preserves the window dimension.
        let new_id = mgr.duplicate_workspace("ws-1").unwrap();
        let dup = mgr.load_workspace(&new_id).unwrap();
        assert_eq!(dup.windows.as_ref().unwrap().len(), 2);
        assert_eq!(dup.tab_groups[1].window_id.as_deref(), Some("win-1"));

        // Export then re-import into a fresh manager preserves it too.
        let json = mgr.export_json(&ConnectionRefMap::default()).unwrap().json;
        assert!(json.contains("\"windowId\""));
        assert!(json.contains("\"windows\""));

        let dir2 = TempDir::new().unwrap();
        let mgr2 = create_test_manager(&dir2);
        mgr2.import_json(&json, &ConnectionRefMap::default())
            .unwrap();
        let imported = mgr2.get_workspaces().unwrap();
        let ws = mgr2.load_workspace(&imported[0].id).unwrap();
        assert_eq!(ws.windows.as_ref().unwrap().len(), 2);
        assert_eq!(ws.tab_groups[1].window_id.as_deref(), Some("win-1"));
    }

    #[test]
    fn export_replaces_ids_with_names() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_workspace(sample_definition("ws-1", "My Setup"))
            .unwrap();

        let id_to_name: HashMap<String, String> =
            [("conn-1".to_string(), "Dev Server".to_string())]
                .into_iter()
                .collect();

        let json = mgr.export_json(&id_to_name.into()).unwrap().json;
        assert!(json.contains("Dev Server"));
        assert!(!json.contains("conn-1"));
        assert!(json.contains("My Setup"));
    }

    #[test]
    fn export_preserves_unknown_connection_ids() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_workspace(sample_definition("ws-1", "Test"))
            .unwrap();

        let id_to_name: HashMap<String, String> = HashMap::new();
        let json = mgr.export_json(&id_to_name.into()).unwrap().json;
        assert!(json.contains("conn-1"));
    }

    #[test]
    fn export_multi_group_workspace() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_workspace(multi_group_definition("ws-1", "Full Stack"))
            .unwrap();

        let id_to_name: HashMap<String, String> = [
            ("conn-1".to_string(), "Dev Server".to_string()),
            ("conn-2".to_string(), "Deploy Server".to_string()),
        ]
        .into_iter()
        .collect();

        let json = mgr.export_json(&id_to_name.into()).unwrap().json;
        assert!(json.contains("Dev"));
        assert!(json.contains("Deploy"));
        assert!(json.contains("Dev Server"));
        assert!(json.contains("Deploy Server"));
        assert!(!json.contains("conn-1"));
        assert!(!json.contains("conn-2"));
    }

    #[test]
    fn import_resolves_names_to_ids() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        let json = r#"{
            "version": "1",
            "workspaces": [{
                "name": "Imported",
                "tabGroups": [{
                    "name": "Main",
                    "layout": {
                        "type": "leaf",
                        "tabs": [{ "connectionRef": "Dev Server" }]
                    }
                }]
            }]
        }"#;

        let name_to_id: HashMap<String, String> =
            [("Dev Server".to_string(), "conn-1".to_string())]
                .into_iter()
                .collect();

        let count = mgr
            .import_json(json, &name_to_id.into())
            .unwrap()
            .imported_count;
        assert_eq!(count, 1);

        let workspaces = mgr.get_workspaces().unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].name, "Imported");

        let ws = mgr.load_workspace(&workspaces[0].id).unwrap();
        assert_eq!(ws.tab_groups.len(), 1);
        if let WorkspaceLayoutNode::Leaf { tabs } = &ws.tab_groups[0].layout {
            assert_eq!(tabs[0].connection_ref.as_deref(), Some("conn-1"));
        } else {
            panic!("Expected leaf layout");
        }
    }

    #[test]
    fn import_skips_duplicate_names() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_workspace(sample_definition("ws-1", "Existing"))
            .unwrap();

        let json = r#"{
            "version": "1",
            "workspaces": [
                { "name": "Existing", "tabGroups": [{ "name": "Main", "layout": { "type": "leaf", "tabs": [] } }] },
                { "name": "New One", "tabGroups": [{ "name": "Main", "layout": { "type": "leaf", "tabs": [] } }] }
            ]
        }"#;

        let count = mgr
            .import_json(json, &ConnectionRefMap::default())
            .unwrap()
            .imported_count;
        assert_eq!(count, 1); // Only "New One" imported

        let workspaces = mgr.get_workspaces().unwrap();
        assert_eq!(workspaces.len(), 2);
    }

    #[test]
    fn preview_import_counts() {
        let json = r#"{
            "version": "1",
            "workspaces": [
                { "name": "WS1", "tabGroups": [{ "name": "Main", "layout": { "type": "leaf", "tabs": [
                    { "connectionRef": "a" }, { "connectionRef": "b" }
                ] } }] },
                { "name": "WS2", "tabGroups": [
                    { "name": "Dev", "layout": { "type": "split", "direction": "horizontal", "children": [
                        { "type": "leaf", "tabs": [{ "connectionRef": "c" }] },
                        { "type": "leaf", "tabs": [{ "connectionRef": "d" }] }
                    ] } },
                    { "name": "Deploy", "layout": { "type": "leaf", "tabs": [{ "connectionRef": "e" }] } }
                ] }
            ]
        }"#;

        let preview = WorkspaceManager::preview_import_json(json).unwrap();
        assert_eq!(preview.workspace_count, 2);
        assert_eq!(preview.total_tab_count, 5); // 2 + 2 + 1
    }

    #[test]
    fn export_import_round_trip() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        mgr.save_workspace(sample_definition("ws-1", "Setup A"))
            .unwrap();
        mgr.save_workspace(multi_group_definition("ws-2", "Setup B"))
            .unwrap();

        let id_to_name: HashMap<String, String> = [
            ("conn-1".to_string(), "Dev Server".to_string()),
            ("conn-2".to_string(), "Deploy Server".to_string()),
        ]
        .into_iter()
        .collect();
        let name_to_id: HashMap<String, String> = [
            ("Dev Server".to_string(), "conn-1".to_string()),
            ("Deploy Server".to_string(), "conn-2".to_string()),
        ]
        .into_iter()
        .collect();

        let exported = mgr.export_json(&id_to_name.into()).unwrap().json;

        // Import into a fresh manager
        let dir2 = TempDir::new().unwrap();
        let mgr2 = create_test_manager(&dir2);
        let count = mgr2
            .import_json(&exported, &name_to_id.into())
            .unwrap()
            .imported_count;
        assert_eq!(count, 2);

        let workspaces = mgr2.get_workspaces().unwrap();
        assert_eq!(workspaces.len(), 2);
        assert!(workspaces.iter().any(|ws| ws.name == "Setup A"));
        assert!(workspaces.iter().any(|ws| ws.name == "Setup B"));

        // Verify multi-group workspace round-tripped correctly
        let setup_b_id = workspaces
            .iter()
            .find(|ws| ws.name == "Setup B")
            .unwrap()
            .id
            .clone();
        let setup_b = mgr2.load_workspace(&setup_b_id).unwrap();
        assert_eq!(setup_b.tab_groups.len(), 2);
        assert_eq!(setup_b.tab_groups[1].name, "Deploy");
    }

    /// PER-009: importing a workspace whose tab references a connection name that
    /// no longer resolves must NOT silently swallow the dangling reference. The
    /// tab is kept (no data loss) with its raw name retained, and a recovery-style
    /// warning naming the workspace + missing connection is produced.
    #[test]
    fn import_warns_on_dangling_connection_ref_but_keeps_tab() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        let json = r#"{
            "version": "1",
            "workspaces": [{
                "name": "Broken Setup",
                "tabGroups": [{
                    "name": "Main",
                    "layout": {
                        "type": "leaf",
                        "tabs": [{ "connectionRef": "Deleted Server" }]
                    }
                }]
            }]
        }"#;

        // Empty connection set → the referenced name cannot resolve.
        let result = mgr.import_json(json, &ConnectionRefMap::default()).unwrap();
        assert_eq!(result.imported_count, 1);

        // (a) The tab is still present and its ref is retained verbatim — no data loss.
        let workspaces = mgr.get_workspaces().unwrap();
        let ws = mgr.load_workspace(&workspaces[0].id).unwrap();
        if let WorkspaceLayoutNode::Leaf { tabs } = &ws.tab_groups[0].layout {
            assert_eq!(tabs.len(), 1);
            assert_eq!(tabs[0].connection_ref.as_deref(), Some("Deleted Server"));
        } else {
            panic!("Expected leaf layout");
        }

        // (b) The warning is returned to the caller (so the UI can surface it),
        // naming the workspace + missing connection.
        assert_eq!(result.warnings.len(), 1);
        assert!(
            result.warnings[0].contains("Broken Setup"),
            "returned warning should name the workspace, got: {}",
            result.warnings[0]
        );
        assert!(
            result.warnings[0].contains("Deleted Server"),
            "returned warning should name the missing connection, got: {}",
            result.warnings[0]
        );

        // (c) The same warning is also recorded in the recovery-warning list.
        let warnings = mgr.take_recovery_warnings();
        assert_eq!(warnings.len(), 1);
        assert!(
            warnings[0].message.contains("Broken Setup"),
            "recovery warning should name the workspace, got: {}",
            warnings[0].message
        );
        assert!(
            warnings[0].message.contains("Deleted Server"),
            "recovery warning should name the missing connection, got: {}",
            warnings[0].message
        );
    }

    /// PER-009 (negative case): a resolvable reference resolves to its id as before
    /// and produces no warning.
    #[test]
    fn import_resolvable_ref_produces_no_warning() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);

        let json = r#"{
            "version": "1",
            "workspaces": [{
                "name": "Fine",
                "tabGroups": [{
                    "name": "Main",
                    "layout": { "type": "leaf", "tabs": [{ "connectionRef": "Dev Server" }] }
                }]
            }]
        }"#;
        let name_to_id: HashMap<String, String> =
            [("Dev Server".to_string(), "conn-1".to_string())]
                .into_iter()
                .collect();

        mgr.import_json(json, &name_to_id.into()).unwrap();

        let workspaces = mgr.get_workspaces().unwrap();
        let ws = mgr.load_workspace(&workspaces[0].id).unwrap();
        if let WorkspaceLayoutNode::Leaf { tabs } = &ws.tab_groups[0].layout {
            assert_eq!(tabs[0].connection_ref.as_deref(), Some("conn-1"));
        } else {
            panic!("Expected leaf layout");
        }
        assert!(
            mgr.take_recovery_warnings().is_empty(),
            "a resolvable ref must not produce a warning"
        );
    }

    #[test]
    fn import_resolves_legacy_plugin_type_ids_in_inline_configs() {
        // PLG-007 follow-up (#3343): an export written before the namespacing
        // carries legacy plugin type ids in inline tab configs.
        let dir = TempDir::new().unwrap();
        crate::connection::plugin_type_ids::write_backend_plugin_manifest(
            dir.path(),
            "beta",
            "k8s",
        );
        let mgr = create_test_manager(&dir);
        let json = r#"{
            "version": "1",
            "workspaces": [{
                "name": "Legacy",
                "tabGroups": [{
                    "name": "Main",
                    "layout": {"type": "leaf", "tabs": [
                        {"inlineConfig": {"type": "k8s", "config": {}}},
                        {"inlineConfig": {"type": "mqtt", "config": {}}}
                    ]}
                }]
            }]
        }"#;
        let count = mgr
            .import_json(json, &ConnectionRefMap::default())
            .unwrap()
            .imported_count;
        assert_eq!(count, 1);
        let id = mgr.get_workspaces().unwrap()[0].id.clone();
        let ws = mgr.load_workspace(&id).unwrap();
        let WorkspaceLayoutNode::Leaf { tabs } = &ws.tab_groups[0].layout else {
            panic!("leaf expected");
        };
        let types: Vec<&str> = tabs
            .iter()
            .map(|t| t.inline_config.as_ref().unwrap()["type"].as_str().unwrap())
            .collect();
        // Resolved to the installed plugin; a missing plugin's id is kept.
        assert_eq!(types, ["plugin:beta:k8s", "mqtt"]);
    }

    fn remap(changes: &[(&str, &str)]) -> ConnectionIdRemap {
        let changes: Vec<crate::connection::id_changes::ConnectionIdChange> = changes
            .iter()
            .map(|(o, n)| crate::connection::id_changes::ConnectionIdChange::new(*o, *n))
            .collect();
        ConnectionIdRemap::new(&changes)
    }

    /// Every tab's `connectionRef` of `ws`, in layout order.
    fn refs_of(ws: &WorkspaceDefinition) -> Vec<Option<String>> {
        fn walk(node: &WorkspaceLayoutNode, out: &mut Vec<Option<String>>) {
            match node {
                WorkspaceLayoutNode::Leaf { tabs } => {
                    out.extend(tabs.iter().map(|t| t.connection_ref.clone()))
                }
                WorkspaceLayoutNode::Split { children, .. } => {
                    children.iter().for_each(|c| walk(c, out))
                }
            }
        }
        let mut out = Vec::new();
        ws.tab_groups.iter().for_each(|g| walk(&g.layout, &mut out));
        out
    }

    #[test]
    fn connection_refs_follow_id_changes_across_groups_and_splits_and_persist() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);
        let mut ws = multi_group_definition("ws-1", "Multi");
        ws.tab_groups[0].layout = WorkspaceLayoutNode::Split {
            direction: SplitDirection::Horizontal,
            children: vec![
                WorkspaceLayoutNode::Leaf {
                    tabs: vec![WorkspaceTabDef {
                        connection_ref: Some("conn-1".to_string()),
                        inline_config: None,
                        agent_ref: None,
                        title: None,
                        initial_command: None,
                    }],
                },
                WorkspaceLayoutNode::Leaf {
                    tabs: vec![WorkspaceTabDef {
                        connection_ref: None,
                        inline_config: Some(serde_json::json!({"type": "local"})),
                        agent_ref: None,
                        title: None,
                        initial_command: None,
                    }],
                },
            ],
            sizes: None,
        };
        mgr.save_workspace(ws).unwrap();

        // A swap: both references exchange in one batch.
        assert!(mgr
            .follow_connection_id_changes(&remap(&[("conn-1", "conn-2"), ("conn-2", "conn-1")]))
            .unwrap());

        let reloaded = WorkspaceManager::new_for_test(dir.path());
        assert_eq!(
            refs_of(&reloaded.load_workspace("ws-1").unwrap()),
            [Some("conn-2".to_string()), None, Some("conn-1".to_string())]
        );
    }

    #[test]
    fn following_unrelated_id_changes_reports_no_change() {
        let dir = TempDir::new().unwrap();
        let mgr = create_test_manager(&dir);
        mgr.save_workspace(sample_definition("ws-1", "One"))
            .unwrap();
        assert!(!mgr
            .follow_connection_id_changes(&remap(&[("zz", "yy")]))
            .unwrap());
        assert_eq!(
            refs_of(&mgr.load_workspace("ws-1").unwrap()),
            [Some("conn-1".to_string())]
        );
    }

    // ── #3625: export/import resolve against the unified connection view ──

    mod unified_view {
        use super::*;
        use crate::connection::config::{ConnectionFolder, SavedConnection};
        use crate::connection::manager::{save_external_file, ConnectionManager};
        use crate::connection::settings::ExternalFileConfig;
        use crate::terminal::backend::ConnectionConfig;
        use std::sync::Arc;

        fn ssh(name: &str, folder: Option<&str>) -> SavedConnection {
            SavedConnection {
                id: match folder {
                    Some(f) => format!("{f}/{name}"),
                    None => name.to_string(),
                },
                name: name.to_string(),
                config: ConnectionConfig {
                    type_id: "ssh".to_string(),
                    settings: serde_json::json!({"host": "h", "port": 22, "username": "u"}),
                },
                folder_id: folder.map(str::to_string),
                terminal_options: None,
                icon: None,
                source_file: None,
            }
        }

        /// A connection manager in `dir` whose main store holds `main` and
        /// which has one enabled external file holding `external`.
        fn connections(
            dir: &TempDir,
            main: Vec<SavedConnection>,
            external: Vec<SavedConnection>,
        ) -> ConnectionManager {
            let ext = dir.path().join("team.json");
            let ext_str = ext.to_str().unwrap().to_string();
            let mut folder_ids: Vec<String> = external
                .iter()
                .filter_map(|c| c.folder_id.clone())
                .collect();
            folder_ids.sort();
            folder_ids.dedup();
            let folders = folder_ids
                .into_iter()
                .map(|id| ConnectionFolder {
                    name: id.clone(),
                    id,
                    parent_id: None,
                    is_expanded: true,
                })
                .collect();
            save_external_file(
                &ext_str,
                "Team",
                folders,
                external,
                &crate::credential::NullStore,
            )
            .unwrap();
            let mgr =
                ConnectionManager::new_for_test(dir.path(), Arc::new(crate::credential::NullStore))
                    .unwrap();
            for conn in main {
                mgr.save_connection(conn).unwrap();
            }
            let mut settings = mgr.get_settings();
            settings.external_connection_files = vec![ExternalFileConfig {
                path: ext_str,
                enabled: true,
            }];
            mgr.save_settings(settings).unwrap();
            mgr
        }

        fn workspace_with_ref(conn_ref: &str) -> WorkspaceDefinition {
            let mut def = sample_definition("ws-1", "Team Setup");
            if let WorkspaceLayoutNode::Leaf { tabs } = &mut def.tab_groups[0].layout {
                tabs[0].connection_ref = Some(conn_ref.to_string());
            }
            def
        }

        fn first_ref(mgr: &WorkspaceManager) -> Option<String> {
            let ws = mgr.get_workspaces().unwrap();
            let def = mgr.load_workspace(&ws[0].id).unwrap();
            match &def.tab_groups[0].layout {
                WorkspaceLayoutNode::Leaf { tabs } => tabs[0].connection_ref.clone(),
                _ => panic!("expected leaf layout"),
            }
        }

        fn unified(conns: &ConnectionManager) -> Vec<SavedConnection> {
            conns.load_unified_view().unwrap().connections
        }

        #[test]
        fn external_file_connection_round_trips_by_name() {
            let dir = TempDir::new().unwrap();
            let conns = connections(
                &dir,
                vec![ssh("Local Box", None)],
                vec![ssh("Web", Some("Prod"))],
            );
            let view = unified(&conns);
            let ext_id = view
                .iter()
                .find(|c| c.source_file.is_some())
                .map(|c| c.id.clone())
                .unwrap();

            let ws_dir = TempDir::new().unwrap();
            let src = WorkspaceManager::new_for_test(ws_dir.path());
            src.save_workspace(workspace_with_ref(&ext_id)).unwrap();
            let exported = src
                .export_json(&ConnectionRefMap::for_export(&view))
                .unwrap();
            assert!(exported.warnings.is_empty(), "{:?}", exported.warnings);
            assert!(exported.json.contains("\"connectionRef\": \"Web\""));

            let dst_dir = TempDir::new().unwrap();
            let dst = WorkspaceManager::new_for_test(dst_dir.path());
            let result = dst
                .import_json(&exported.json, &ConnectionRefMap::for_import(&view))
                .unwrap();
            assert_eq!(result.imported_count, 1);
            assert!(result.warnings.is_empty(), "{:?}", result.warnings);
            assert_eq!(first_ref(&dst), Some(ext_id));
        }

        #[test]
        fn id_held_by_main_store_and_external_file_exports_with_warning() {
            let dir = TempDir::new().unwrap();
            let conns = connections(&dir, vec![ssh("Web", None)], vec![ssh("Web", None)]);
            let view = unified(&conns);
            assert_eq!(view.iter().filter(|c| c.id == "Web").count(), 2);

            let ws_dir = TempDir::new().unwrap();
            let src = WorkspaceManager::new_for_test(ws_dir.path());
            src.save_workspace(workspace_with_ref("Web")).unwrap();
            let exported = src
                .export_json(&ConnectionRefMap::for_export(&view))
                .unwrap();
            // The raw id is kept (no portable name) and the user is told why.
            assert!(exported.json.contains("\"connectionRef\": \"Web\""));
            assert_eq!(exported.warnings.len(), 1, "{:?}", exported.warnings);
            let warning = &exported.warnings[0];
            assert!(warning.contains("Team Setup"), "{warning}");
            assert!(warning.contains("main connection store"), "{warning}");
            assert!(warning.contains("team.json"), "{warning}");
        }

        #[test]
        fn name_matching_several_connections_imports_unlinked_with_warning() {
            let dir = TempDir::new().unwrap();
            let conns = connections(&dir, vec![ssh("Web", None)], vec![ssh("Web", Some("Prod"))]);
            let view = unified(&conns);
            let json = r#"{
                "version": "1",
                "workspaces": [{
                    "name": "Imported",
                    "tabGroups": [{
                        "name": "Main",
                        "layout": { "type": "leaf", "tabs": [{ "connectionRef": "Web" }] }
                    }]
                }]
            }"#;

            let ws_dir = TempDir::new().unwrap();
            let mgr = WorkspaceManager::new_for_test(ws_dir.path());
            let result = mgr
                .import_json(json, &ConnectionRefMap::for_import(&view))
                .unwrap();
            assert_eq!(result.imported_count, 1);
            // Never guessed: the tab keeps the raw name, bound to neither id.
            assert_eq!(first_ref(&mgr), Some("Web".to_string()));
            assert_eq!(result.warnings.len(), 1, "{:?}", result.warnings);
            let warning = &result.warnings[0];
            assert!(warning.contains("matches several connections"), "{warning}");
            assert!(warning.contains("team.json"), "{warning}");
        }

        /// An export file written before #3625 (plain `version: "1"`, names
        /// only) still imports, now also resolving names from external files.
        #[test]
        fn pre_3625_export_file_still_imports() {
            let dir = TempDir::new().unwrap();
            let conns = connections(
                &dir,
                vec![ssh("Local Box", None)],
                vec![ssh("Web", Some("Prod"))],
            );
            let view = unified(&conns);
            let web_id = view.iter().find(|c| c.name == "Web").unwrap().id.clone();
            let local_id = view
                .iter()
                .find(|c| c.name == "Local Box")
                .unwrap()
                .id
                .clone();
            let json = r#"{
                "version": "1",
                "workspaces": [{
                    "name": "Legacy",
                    "description": "exported by an older build",
                    "tabGroups": [{
                        "name": "Main",
                        "layout": {
                            "type": "split",
                            "direction": "horizontal",
                            "children": [
                                { "type": "leaf", "tabs": [{ "connectionRef": "Local Box" }] },
                                { "type": "leaf", "tabs": [{ "connectionRef": "Web" }] }
                            ]
                        }
                    }]
                }]
            }"#;

            let ws_dir = TempDir::new().unwrap();
            let mgr = WorkspaceManager::new_for_test(ws_dir.path());
            let result = mgr
                .import_json(json, &ConnectionRefMap::for_import(&view))
                .unwrap();
            assert_eq!(result.imported_count, 1);
            assert!(result.warnings.is_empty(), "{:?}", result.warnings);
            let ws = mgr.get_workspaces().unwrap();
            let def = mgr.load_workspace(&ws[0].id).unwrap();
            let WorkspaceLayoutNode::Split { children, .. } = &def.tab_groups[0].layout else {
                panic!("expected split layout");
            };
            let refs: Vec<Option<String>> = children
                .iter()
                .map(|c| match c {
                    WorkspaceLayoutNode::Leaf { tabs } => tabs[0].connection_ref.clone(),
                    _ => None,
                })
                .collect();
            assert_eq!(refs, vec![Some(local_id), Some(web_id)]);
        }
    }
}

//! `schedules.json` v2 → v3: schedules run automations (#5818, slice 10).
//!
//! Up to v2 a schedule's action named a macro (`{kind: "macro", macroId}`) or
//! a workflow (`{kind: "workflow", workflowId}`), and each attempt linked the
//! run-history records it produced as `macroRunIds` / `workflowRunIds`. In v3
//! the action is `{kind: "automation", automationId}` and the attempt keeps one
//! `runIds` list (the automation run history keeps the legacy run ids).
//!
//! Ids are kept, except where the automation migration had to change one: a
//! macro whose id was taken by a workflow (or by an earlier macro) became an
//! `automation-<id>` automation. [`AutomationIdMap`] follows those changes from
//! `automations.json`, so a macro schedule keeps running that macro. An id that
//! no legacy entry had keeps failing clearly: when it would now resolve to an
//! automation of the *other* kind it is pointed at `missing-macro-<id>` /
//! `missing-workflow-<id>` (never silently running a workflow in place of a
//! deleted macro); otherwise it stays as it is, and the run is skipped with
//! "The automation no longer exists".
//!
//! [`migrate_schedules`] runs in the boot migration, right after the library
//! migration, so it sees the id map. It copies the v1/v2 file to
//! `schedules.json.pre-automations.bak` once before rewriting it. A v2 build
//! then refuses to overwrite the v3 file (PER-004) and reports it unreadable
//! instead of discarding it. The in-memory migration of the versioned-store
//! gate (a restored backup, or a boot whose automation migration failed) has
//! no id map: it marks each action with its `legacySource`, and the next
//! [`migrate_schedules`] resolves it. A restore is swapped in before the boot
//! migration, so that is the same start.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde_json::{Map, Value};

use crate::automations::config::LegacySource;
use crate::automations::convert::MISSING_MACRO_PREFIX;
use crate::automations::legacy::backup_once;
use crate::automations::store::{AutomationStore, LegacyFileRecord};
use crate::connection::recovery::RecoveryWarning;
use crate::schedules::config::ScheduleStore;
use crate::utils::fs::write_atomic;
use crate::utils::migrate::{
    load_versioned, read_version, LoadOutcome, VersionedStore, ASSUMED_VERSION,
};

/// The schedules file.
pub const SCHEDULES_FILE: &str = "schedules.json";

/// Prefix of the id a workflow schedule is pointed at when its workflow no
/// longer existed but the id now belongs to a converted macro.
pub const MISSING_WORKFLOW_PREFIX: &str = "missing-workflow-";

/// Legacy macro / workflow id → the automation id it became.
#[derive(Debug, Default, Clone)]
pub struct AutomationIdMap {
    macros: HashMap<String, String>,
    workflows: HashMap<String, String>,
    /// Every automation id in the store.
    taken: HashSet<String>,
}

impl AutomationIdMap {
    /// The map of `store`: the first entry of each legacy id in the
    /// provenance records (the entry a schedule resolved to), then, for a
    /// store without provenance (restored from a backup), the converted
    /// automations' own ids and the recorded `idRemaps`.
    pub fn from_store(store: &AutomationStore) -> Self {
        let mut map = Self {
            taken: store.automations.iter().map(|a| a.id.clone()).collect(),
            ..Self::default()
        };
        if let Some(provenance) = &store.migrated_from {
            add_records(&mut map.macros, provenance.macros.as_ref());
            add_records(&mut map.workflows, provenance.workflows.as_ref());
        }
        for automation in &store.automations {
            if let Some(legacy) = &automation.legacy {
                map.ids_of(legacy.from)
                    .entry(automation.id.clone())
                    .or_insert_with(|| automation.id.clone());
            }
        }
        for remap in &store.id_remaps {
            map.ids_of(remap.source)
                .entry(remap.old_id.clone())
                .or_insert_with(|| remap.new_id.clone());
        }
        map
    }

    fn ids_of(&mut self, source: LegacySource) -> &mut HashMap<String, String> {
        match source {
            LegacySource::Macro => &mut self.macros,
            LegacySource::Workflow => &mut self.workflows,
        }
    }

    /// The automation id a schedule of the legacy `source` kind naming `id`
    /// now runs.
    pub fn resolve(&self, source: LegacySource, id: &str) -> String {
        let (ids, missing_prefix) = match source {
            LegacySource::Macro => (&self.macros, MISSING_MACRO_PREFIX),
            LegacySource::Workflow => (&self.workflows, MISSING_WORKFLOW_PREFIX),
        };
        if let Some(target) = ids.get(id) {
            return target.clone();
        }
        if !self.taken.contains(id) {
            return id.to_string();
        }
        // The id is an automation of the other kind now: keep failing.
        let base = format!("{missing_prefix}{id}");
        let mut candidate = base.clone();
        let mut n = 2u32;
        while self.taken.contains(&candidate) {
            candidate = format!("{base}-{n}");
            n += 1;
        }
        candidate
    }
}

/// Add `legacy id → automation id` for the first entry of each legacy id.
fn add_records(ids: &mut HashMap<String, String>, record: Option<&LegacyFileRecord>) {
    for entry in record.into_iter().flat_map(|r| &r.entries) {
        if entry.occurrence == 1 {
            ids.entry(entry.legacy_id.clone())
                .or_insert_with(|| entry.automation_id.clone());
        }
    }
}

/// Schema v2 → v3 over the raw document: rewrite every action to the
/// `automation` kind through `ids`, merge each attempt's `workflowRunIds` and
/// `macroRunIds` into `runIds`, and stamp version `"3"`. Odd shapes are left
/// for the per-schedule salvage. Without `ids` every action keeps its id and
/// is marked with its `legacySource` until [`migrate_schedules`] resolves it.
pub fn migrate_v2_to_v3(mut value: Value, ids: Option<&AutomationIdMap>) -> Value {
    let Some(obj) = value.as_object_mut() else {
        return value;
    };
    if let Some(schedules) = obj.get_mut("schedules").and_then(Value::as_array_mut) {
        for schedule in schedules.iter_mut().filter_map(Value::as_object_mut) {
            if let Some(action) = schedule.get_mut("action").and_then(Value::as_object_mut) {
                migrate_action(action, ids);
            }
            if let Some(last) = schedule
                .get_mut("lastResult")
                .and_then(Value::as_object_mut)
            {
                merge_run_ids(last);
            }
            if let Some(history) = schedule.get_mut("history").and_then(Value::as_array_mut) {
                for attempt in history.iter_mut().filter_map(Value::as_object_mut) {
                    merge_run_ids(attempt);
                }
            }
        }
    }
    obj.insert("version".to_string(), Value::String("3".to_string()));
    value
}

/// `{macro, macroId}` / `{workflow, workflowId}` → `{automation, automationId}`.
/// Without an id map the action is marked pending with its `legacySource`.
fn migrate_action(action: &mut Map<String, Value>, ids: Option<&AutomationIdMap>) {
    let (source, name, key) = match action.get("kind").and_then(Value::as_str) {
        Some("macro") => (LegacySource::Macro, "macro", "macroId"),
        Some("workflow") => (LegacySource::Workflow, "workflow", "workflowId"),
        _ => return,
    };
    let Some(id) = action.get(key).and_then(Value::as_str).map(str::to_string) else {
        return;
    };
    action.remove(key);
    action.insert("kind".to_string(), Value::String("automation".to_string()));
    let id = match ids {
        Some(ids) => ids.resolve(source, &id),
        None => {
            action.insert("legacySource".to_string(), Value::String(name.to_string()));
            id
        }
    };
    action.insert("automationId".to_string(), Value::String(id));
}

/// Resolve the actions [`migrate_v2_to_v3`] left pending; returns whether
/// there were any.
fn resolve_pending(value: &mut Value, ids: &AutomationIdMap) -> bool {
    let mut changed = false;
    let schedules = value.get_mut("schedules").and_then(Value::as_array_mut);
    for schedule in schedules.into_iter().flatten() {
        let Some(action) = schedule.get_mut("action").and_then(Value::as_object_mut) else {
            continue;
        };
        let source = match action.get("legacySource").and_then(Value::as_str) {
            Some("macro") => LegacySource::Macro,
            Some("workflow") => LegacySource::Workflow,
            _ => continue,
        };
        let Some(id) = action.get("automationId").and_then(Value::as_str) else {
            continue;
        };
        let id = ids.resolve(source, id);
        action.remove("legacySource");
        action.insert("automationId".to_string(), Value::String(id));
        changed = true;
    }
    changed
}

/// Fold an attempt's legacy run-id lists into `runIds` (order kept, no
/// duplicates).
fn merge_run_ids(attempt: &mut Map<String, Value>) {
    let mut merged: Vec<Value> = Vec::new();
    for key in ["runIds", "workflowRunIds", "macroRunIds"] {
        let Some(list) = attempt.remove(key) else {
            continue;
        };
        for id in list.as_array().into_iter().flatten() {
            if id.is_string() && !merged.contains(id) {
                merged.push(id.clone());
            }
        }
    }
    if !merged.is_empty() {
        attempt.insert("runIds".to_string(), Value::Array(merged));
    }
}

/// What the schedules migration did on this boot.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SchedulesReport {
    /// The version the file was migrated from, when it was.
    pub migrated_from: Option<u32>,
    /// Why the migration failed, when it did.
    pub error: Option<String>,
}

/// The recovery warning for a failed migration.
pub fn failure_warning(report: &SchedulesReport) -> Option<RecoveryWarning> {
    let details = report.error.clone()?;
    Some(RecoveryWarning {
        file_name: SCHEDULES_FILE.to_string(),
        message: "Could not update all schedules to automations. The update runs again on the \
                  next start."
            .to_string(),
        details: Some(details),
    })
}

/// Migrate `schedules.json` in `dir` to v3 with the id map of the
/// `automations.json` next to it, and resolve what an earlier in-memory
/// migration left pending in a v3 file. A missing, newer or corrupt schedules
/// file is left alone (the schedule manager reports the last two), and so is
/// everything while `automations.json` cannot be read: the manager's in-memory
/// migration then marks the actions pending.
pub fn migrate_schedules(dir: &Path) -> Result<SchedulesReport> {
    let path = dir.join(SCHEDULES_FILE);
    if !path.exists() {
        return Ok(SchedulesReport::default());
    }
    let raw = fs::read_to_string(&path).context("Failed to read schedules.json")?;
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Ok(SchedulesReport::default());
    };
    let version = read_version(&value).unwrap_or(ASSUMED_VERSION);
    if version > ScheduleStore::CURRENT_VERSION {
        return Ok(SchedulesReport::default());
    }
    let Some(ids) = automation_ids(dir)? else {
        return Ok(SchedulesReport::default());
    };
    if version >= 3 {
        let mut value = value;
        if resolve_pending(&mut value, &ids) {
            write_schedules(&path, &value)?;
        }
        return Ok(SchedulesReport::default());
    }
    backup_once(dir, &[SCHEDULES_FILE])?;
    let value = if version < 2 {
        crate::schedules::history::migrate_v1_to_v2(value)
    } else {
        value
    };
    write_schedules(&path, &migrate_v2_to_v3(value, Some(&ids)))?;
    Ok(SchedulesReport {
        migrated_from: Some(version),
        error: None,
    })
}

/// Write the document atomically.
fn write_schedules(path: &Path, value: &Value) -> Result<()> {
    let data = serde_json::to_string_pretty(value).context("Failed to serialize schedules")?;
    write_atomic(path, data).context("Failed to write schedules.json")
}

/// The id map of `automations.json` in `dir`, or `None` when it is missing,
/// newer or corrupt.
fn automation_ids(dir: &Path) -> Result<Option<AutomationIdMap>> {
    let path = dir.join(AutomationStore::FILE_NAME);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).context("Failed to read automations.json")?;
    Ok(match load_versioned::<AutomationStore>(&raw) {
        LoadOutcome::Loaded { data, .. } => Some(AutomationIdMap::from_store(&data)),
        _ => None,
    })
}

#[cfg(test)]
#[path = "migrate_tests.rs"]
mod tests;

//! The boot migration from `macro-runs.json` + `runs.json` to
//! `automation-runs.json`, and its reconcile pass (#5818, slice 2).
//!
//! First run: copy both legacy files to `<name>.pre-automations.bak` once and
//! write the union ([`merge_runs`]). Later boots: when a legacy file's hash
//! moved, add the runs whose ids were not in it at the last sync, then apply
//! the retention rules again. Clearing the new history is never undone by an
//! old run coming back, and the legacy files are never written.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};

use super::history::{
    apply_retention, from_macro_run, from_workflow_run, merge_runs, sort_oldest_first,
    AutomationRun, AutomationRunHistoryStore, LegacyRunsRecord,
};
use super::legacy::{backup_once, read_legacy, LegacyRead};
use super::storage::StoreFile;
use crate::macros::history::MacroRunHistoryStore;
use crate::utils::migrate::{load_versioned, LoadOutcome};
use crate::workflows::history::WorkflowRunHistoryStore;

/// The legacy macro run-history file.
pub const MACRO_RUNS_FILE: &str = "macro-runs.json";
/// The legacy workflow run-history file.
pub const WORKFLOW_RUNS_FILE: &str = "runs.json";

/// What the run-history migration did on this boot.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RunsReport {
    /// `automation-runs.json` was created on this boot.
    pub created: bool,
    /// Legacy runs added by the reconcile pass.
    pub merged: usize,
}

/// One legacy run file, read and converted.
struct LegacyRuns {
    file_name: &'static str,
    read: Option<(String, Vec<AutomationRun>)>,
    absent: bool,
}

/// Migrate or reconcile `automation-runs.json` in `dir`. `macro_ids` maps a
/// legacy macro id to the automation id it became, where it changed.
pub fn migrate_runs(
    dir: &Path,
    macro_ids: &HashMap<String, String>,
    now: DateTime<Utc>,
) -> Result<RunsReport> {
    let file = StoreFile::<AutomationRunHistoryStore>::in_dir(dir);
    let macro_runs = read_legacy::<MacroRunHistoryStore>(&dir.join(MACRO_RUNS_FILE))?;
    let workflow_runs = read_legacy::<WorkflowRunHistoryStore>(&dir.join(WORKFLOW_RUNS_FILE))?;

    if !file.path().exists() {
        backup_once(dir, &[MACRO_RUNS_FILE, WORKFLOW_RUNS_FILE])?;
        let store = first_migration(&macro_runs, &workflow_runs, macro_ids, now);
        file.save(&store)?;
        return Ok(RunsReport {
            created: true,
            merged: 0,
        });
    }

    let raw = fs::read_to_string(file.path()).context("Failed to read automation-runs.json")?;
    let LoadOutcome::Loaded {
        data: mut store, ..
    } = load_versioned::<AutomationRunHistoryStore>(&raw)
    else {
        return Ok(RunsReport::default());
    };
    let legacy = [
        legacy_runs(MACRO_RUNS_FILE, &macro_runs, |s| {
            s.runs
                .iter()
                .map(|r| from_macro_run(r, macro_ids))
                .collect()
        }),
        legacy_runs(WORKFLOW_RUNS_FILE, &workflow_runs, |s| {
            s.runs.iter().map(from_workflow_run).collect()
        }),
    ];
    let before = store.migrated_from.clone();
    let mut merged = 0;
    for runs in legacy {
        merged += reconcile_file(&mut store, runs);
    }
    if merged > 0 {
        sort_oldest_first(&mut store.runs);
        apply_retention(&mut store.runs, now);
    }
    if merged > 0 || store.migrated_from != before {
        file.save(&store)?;
    }
    Ok(RunsReport {
        created: false,
        merged,
    })
}

fn first_migration(
    macro_runs: &LegacyRead<MacroRunHistoryStore>,
    workflow_runs: &LegacyRead<WorkflowRunHistoryStore>,
    macro_ids: &HashMap<String, String>,
    now: DateTime<Utc>,
) -> AutomationRunHistoryStore {
    let macro_list = match macro_runs {
        LegacyRead::Read { store, .. } => store.runs.as_slice(),
        _ => &[],
    };
    let workflow_list = match workflow_runs {
        LegacyRead::Read { store, .. } => store.runs.as_slice(),
        _ => &[],
    };
    let mut store = AutomationRunHistoryStore {
        runs: merge_runs(macro_list, workflow_list, macro_ids, now),
        ..AutomationRunHistoryStore::default()
    };
    let records = [
        (
            MACRO_RUNS_FILE,
            first_record(macro_runs, macro_list.iter().map(|r| r.id.clone())),
        ),
        (
            WORKFLOW_RUNS_FILE,
            first_record(workflow_runs, workflow_list.iter().map(|r| r.id.clone())),
        ),
    ];
    for (name, record) in records {
        if let Some(record) = record {
            store.migrated_from.insert(name.to_string(), record);
        }
    }
    store
}

/// An absent file is recorded empty (so runs an older build writes later
/// are merged); an unreadable one is left unrecorded.
fn first_record<T>(
    read: &LegacyRead<T>,
    ids: impl Iterator<Item = String>,
) -> Option<LegacyRunsRecord> {
    match read {
        LegacyRead::Absent => Some(LegacyRunsRecord::default()),
        LegacyRead::Read { sha256, .. } => Some(LegacyRunsRecord {
            sha256: sha256.clone(),
            run_ids: ids.collect(),
        }),
        LegacyRead::Unreadable(_) => None,
    }
}

fn legacy_runs<T>(
    file_name: &'static str,
    read: &LegacyRead<T>,
    convert: impl Fn(&T) -> Vec<AutomationRun>,
) -> LegacyRuns {
    match read {
        LegacyRead::Read { store, sha256, .. } => LegacyRuns {
            file_name,
            read: Some((sha256.clone(), convert(store))),
            absent: false,
        },
        LegacyRead::Absent => LegacyRuns {
            file_name,
            read: None,
            absent: true,
        },
        LegacyRead::Unreadable(_) => LegacyRuns {
            file_name,
            read: None,
            absent: false,
        },
    }
}

/// Merge one legacy run file; returns how many runs were added.
fn reconcile_file(store: &mut AutomationRunHistoryStore, legacy: LegacyRuns) -> usize {
    let record = store.migrated_from.get(legacy.file_name).cloned();
    let Some((sha256, runs)) = legacy.read else {
        if legacy.absent {
            store
                .migrated_from
                .insert(legacy.file_name.to_string(), LegacyRunsRecord::default());
        }
        return 0;
    };
    let run_ids: Vec<String> = runs.iter().map(|r| r.id.clone()).collect();
    let next = LegacyRunsRecord { sha256, run_ids };
    let mut added = 0;
    match record {
        Some(record) if record.sha256 == next.sha256 => return 0,
        // Restored from a backup: adopt the file as it is now.
        None => {}
        Some(record) => {
            let synced: HashSet<&str> = record.run_ids.iter().map(String::as_str).collect();
            let present: HashSet<String> = store.runs.iter().map(|r| r.id.clone()).collect();
            for run in runs {
                if !synced.contains(run.id.as_str()) && !present.contains(&run.id) {
                    store.runs.push(run);
                    added += 1;
                }
            }
        }
    }
    store
        .migrated_from
        .insert(legacy.file_name.to_string(), next);
    added
}

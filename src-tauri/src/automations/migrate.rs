//! The boot migration from `macros.json` + `workflows.json` to
//! `automations.json`, and the reconcile pass that merges back what an older
//! build changed in the legacy files (#5818, slice 2).
//!
//! Runs at boot, before any automation, macro or workflow manager loads:
//!
//! 1. `automations.json` missing: copy each legacy file to
//!    `<name>.pre-automations.bak` once, convert both libraries with
//!    [`convert_library`], and write `automations.json` with a fingerprint of
//!    every legacy entry (`migratedFrom`) and the changed-id list
//!    (`idRemaps`).
//! 2. `automations.json` present: for each legacy file whose hash moved,
//!    merge entry by entry. An entry the older build added is added. An entry
//!    it changed replaces the automation when the new build left that
//!    automation alone, and is kept as a copy whose name ends in
//!    [`CONFLICT_SUFFIX`] when both sides changed it. Deletions on the legacy side are
//!    not followed (no step lists are merged and nothing is ever lost).
//! 3. Once, at the switch-over (#5971): the first boot of a build whose UI
//!    writes only `automations.json` (slice 4, marked by `legacyFrozenAt`)
//!    follows the deletions the old UI made in the legacy files while they
//!    were still the live stores (slices 2–3). See
//!    `follow_transition_deletions`. From then on a legacy-side deletion can
//!    only come from an older build and is not followed.
//!
//! The legacy files are never written. A newer or corrupt `automations.json`
//! is left to the manager's own recovery and not touched here.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};

use super::config::{Automation, AutomationStep, LegacySource};
use super::convert::{convert_library, from_macro, from_workflow, ConvertedLibrary, REID_PREFIX};
use super::legacy::{backup_once, entry_hash, read_legacy, LegacyRead};
use super::storage::StoreFile;
use super::store::{
    AutomationStore, LegacyEntryRecord, LegacyFileRecord, LegacyProvenance, RecordedIdRemap,
};
use crate::connection::recovery::RecoveryWarning;
use crate::macros::config::MacroStore;
use crate::utils::migrate::{load_versioned, LoadOutcome};
use crate::workflows::config::WorkflowStore;

/// The legacy library files.
pub const MACROS_FILE: &str = "macros.json";
/// See [`MACROS_FILE`].
pub const WORKFLOWS_FILE: &str = "workflows.json";

/// Suffix appended to the name of a conflict copy.
pub const CONFLICT_SUFFIX: &str = " (from older version)";

/// What the library migration did on this boot.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct LibraryReport {
    /// `automations.json` was created on this boot.
    pub created: bool,
    /// Legacy entries merged in by the reconcile pass (added or replaced).
    pub merged: usize,
    /// Of those, entries both sides changed, kept as copies.
    pub conflicts: usize,
    /// Legacy macro id → automation id, for every macro whose id changed.
    /// The run-history migration follows it.
    pub macro_ids: HashMap<String, String>,
    /// Automations removed at the switch-over because the old UI had deleted
    /// them from a legacy file during the transition (#5971).
    pub followed_deletions: usize,
}

/// One legacy entry, converted, with its fingerprint.
struct LegacyEntry {
    legacy_id: String,
    occurrence: u32,
    sha256: String,
    updated_at: String,
    automation: Automation,
}

/// Migrate or reconcile `automations.json` in `dir`.
pub fn migrate_library(dir: &Path) -> Result<LibraryReport> {
    let file = StoreFile::<AutomationStore>::in_dir(dir);
    let macros = read_legacy::<MacroStore>(&dir.join(MACROS_FILE))?;
    let workflows = read_legacy::<WorkflowStore>(&dir.join(WORKFLOWS_FILE))?;

    let now = chrono::Utc::now().to_rfc3339();
    if !file.path().exists() {
        backup_once(dir, &[MACROS_FILE, WORKFLOWS_FILE])?;
        let mut store = first_migration(&macros, &workflows);
        store.legacy_frozen_at = Some(now);
        file.save(&store)?;
        return Ok(LibraryReport {
            created: true,
            macro_ids: macro_id_map(&store),
            ..LibraryReport::default()
        });
    }

    let raw = fs::read_to_string(file.path()).context("Failed to read automations.json")?;
    let LoadOutcome::Loaded {
        data: mut store, ..
    } = load_versioned::<AutomationStore>(&raw)
    else {
        // Newer or corrupt: the manager reports it; never write over it here.
        return Ok(LibraryReport::default());
    };
    let before = store.clone();
    let mut report = reconcile(&mut store, &macros, &workflows);
    if store.legacy_frozen_at.is_none() {
        // A store restored from a backup (no provenance) adopted the legacy
        // files above instead of syncing with them: nothing to follow.
        if before.migrated_from.is_some() {
            report.followed_deletions = follow_transition_deletions(
                &mut store,
                matches!(macros, LegacyRead::Read { .. }),
                matches!(workflows, LegacyRead::Read { .. }),
            );
        }
        store.legacy_frozen_at = Some(now);
    }
    if store.migrated_from != before.migrated_from
        || store.automations != before.automations
        || store.legacy_frozen_at != before.legacy_frozen_at
    {
        file.save(&store)?;
    }
    report.macro_ids = macro_id_map(&store);
    Ok(report)
}

/// Follow, once, the deletions the old UI made in the legacy files while they
/// were the live stores (#5971). Returns how many automations it removed.
///
/// Until the switch-over the UI wrote only `macros.json` and `workflows.json`,
/// and the reconcile pass carried every edit into `automations.json`, but no
/// deletion. After the reconcile above, the provenance records name exactly
/// the automations that still have a legacy entry. A converted automation
/// (`legacy` set) whose source file was read cleanly and that no record
/// names was deleted in the old UI, so it is removed here instead of
/// reappearing. Nothing else wrote `automations.json` during the transition,
/// so such an automation is unchanged since its last sync. Automations of a
/// file that is absent or unreadable are kept: a missing file is not a
/// deletion of everything in it.
fn follow_transition_deletions(
    store: &mut AutomationStore,
    macros_read: bool,
    workflows_read: bool,
) -> usize {
    let Some(provenance) = &store.migrated_from else {
        return 0;
    };
    let mapped = |record: &Option<LegacyFileRecord>| -> Option<HashSet<String>> {
        record
            .as_ref()
            .map(|r| r.entries.iter().map(|e| e.automation_id.clone()).collect())
    };
    let macro_ids = mapped(&provenance.macros).filter(|_| macros_read);
    let workflow_ids = mapped(&provenance.workflows).filter(|_| workflows_read);
    let before = store.automations.len();
    store.automations.retain(|a| {
        let ids = match a.legacy.as_ref().map(|l| l.from) {
            Some(LegacySource::Macro) => macro_ids.as_ref(),
            Some(LegacySource::Workflow) => workflow_ids.as_ref(),
            None => None,
        };
        ids.is_none_or(|ids| ids.contains(&a.id))
    });
    before - store.automations.len()
}

/// Build `automations.json` from both legacy libraries.
fn first_migration(
    macros: &LegacyRead<MacroStore>,
    workflows: &LegacyRead<WorkflowStore>,
) -> AutomationStore {
    let macro_list = match macros {
        LegacyRead::Read { store, .. } => store.macros.as_slice(),
        _ => &[],
    };
    let workflow_list = match workflows {
        LegacyRead::Read { store, .. } => store.workflows.as_slice(),
        _ => &[],
    };
    let ConvertedLibrary {
        automations,
        remapped,
        ..
    } = convert_library(macro_list, workflow_list);
    let (converted_macros, converted_workflows) = automations.split_at(macro_list.len());

    let macro_entries = fingerprint(
        macro_list
            .iter()
            .map(|m| (m.id.as_str(), &m.updated_at, entry_hash(m))),
        converted_macros,
    );
    let workflow_entries = fingerprint(
        workflow_list
            .iter()
            .map(|w| (w.id.as_str(), &w.updated_at, entry_hash(w))),
        converted_workflows,
    );
    AutomationStore {
        migrated_from: Some(LegacyProvenance {
            macros: file_record(macros, macro_entries),
            workflows: file_record(workflows, workflow_entries),
        }),
        id_remaps: remapped
            .into_iter()
            .map(|r| RecordedIdRemap {
                source: r.source,
                old_id: r.old_id,
                new_id: r.new_id,
            })
            .collect(),
        automations,
        ..AutomationStore::default()
    }
}

/// Pair legacy entries with the automations they became.
fn fingerprint<'a>(
    legacy: impl Iterator<Item = (&'a str, &'a String, String)>,
    converted: &[Automation],
) -> Vec<LegacyEntryRecord> {
    let mut seen: HashMap<&str, u32> = HashMap::new();
    legacy
        .zip(converted)
        .map(|((id, updated_at, sha256), automation)| {
            let occurrence = next_occurrence(&mut seen, id);
            LegacyEntryRecord {
                legacy_id: id.to_string(),
                occurrence,
                sha256,
                updated_at: updated_at.clone(),
                automation_id: automation.id.clone(),
            }
        })
        .collect()
}

/// The provenance record for one legacy file. An absent file is recorded
/// with an empty hash, so a file an older build creates later is merged; an
/// unreadable file is not recorded, so it is adopted once it can be read.
fn file_record<T>(
    read: &LegacyRead<T>,
    entries: Vec<LegacyEntryRecord>,
) -> Option<LegacyFileRecord> {
    match read {
        LegacyRead::Absent => Some(LegacyFileRecord::default()),
        LegacyRead::Read {
            version, sha256, ..
        } => Some(LegacyFileRecord {
            version: *version,
            sha256: sha256.clone(),
            entries,
        }),
        LegacyRead::Unreadable => None,
    }
}

/// Merge what changed in the legacy files since the last sync.
fn reconcile(
    store: &mut AutomationStore,
    macros: &LegacyRead<MacroStore>,
    workflows: &LegacyRead<WorkflowStore>,
) -> LibraryReport {
    let mut report = LibraryReport::default();
    let mut provenance = store.migrated_from.clone().unwrap_or_default();
    // A store without any provenance (restored from a backup) adopts the
    // legacy files as they are now instead of merging them.
    let adopt = store.migrated_from.is_none();

    let macro_entries = legacy_entries(macros, |s: &MacroStore| {
        s.macros
            .iter()
            .map(|m| {
                (
                    m.id.clone(),
                    m.updated_at.clone(),
                    entry_hash(m),
                    from_macro(m),
                )
            })
            .collect()
    });
    provenance.macros = reconcile_file(
        &mut store.automations,
        provenance.macros.take(),
        macros,
        macro_entries,
        adopt,
        &mut report,
    );

    let macro_ids = provenance
        .macros
        .as_ref()
        .map(record_id_map)
        .unwrap_or_default();
    let workflow_entries = legacy_entries(workflows, |s: &WorkflowStore| {
        s.workflows
            .iter()
            .map(|w| {
                let mut automation = from_workflow(w);
                follow_macro_ids(&mut automation.steps, &macro_ids);
                (
                    w.id.clone(),
                    w.updated_at.clone(),
                    entry_hash(w),
                    automation,
                )
            })
            .collect()
    });
    provenance.workflows = reconcile_file(
        &mut store.automations,
        provenance.workflows.take(),
        workflows,
        workflow_entries,
        adopt,
        &mut report,
    );
    store.migrated_from = Some(provenance);
    report
}

type RawEntry = (String, String, String, Automation);

/// The entries of a readable legacy file, with their occurrence numbers.
fn legacy_entries<T>(
    read: &LegacyRead<T>,
    convert: impl Fn(&T) -> Vec<RawEntry>,
) -> Vec<LegacyEntry> {
    let LegacyRead::Read { store, .. } = read else {
        return Vec::new();
    };
    let mut seen: HashMap<String, u32> = HashMap::new();
    convert(store)
        .into_iter()
        .map(|(legacy_id, updated_at, sha256, automation)| {
            let counter = seen.entry(legacy_id.clone()).or_insert(0);
            *counter += 1;
            LegacyEntry {
                occurrence: *counter,
                legacy_id,
                sha256,
                updated_at,
                automation,
            }
        })
        .collect()
}

/// Reconcile one legacy file; returns its new provenance record.
fn reconcile_file<T>(
    automations: &mut Vec<Automation>,
    record: Option<LegacyFileRecord>,
    read: &LegacyRead<T>,
    entries: Vec<LegacyEntry>,
    adopt: bool,
    report: &mut LibraryReport,
) -> Option<LegacyFileRecord> {
    let (version, sha256) = match read {
        // Deleted by an older build: nothing to merge, nothing is deleted.
        LegacyRead::Absent => return Some(LegacyFileRecord::default()),
        // Keep the last good record so the entries compare correctly once
        // the file can be read again.
        LegacyRead::Unreadable => return record,
        LegacyRead::Read {
            version, sha256, ..
        } => (*version, sha256.clone()),
    };
    if let Some(record) = &record {
        if record.sha256 == sha256 {
            return Some(record.clone());
        }
    }
    let previous = record.map(|r| r.entries).unwrap_or_default();
    let mut taken: HashSet<String> = automations.iter().map(|a| a.id.clone()).collect();
    let mut records = Vec::with_capacity(entries.len());
    for entry in entries {
        let prev = previous
            .iter()
            .find(|p| p.legacy_id == entry.legacy_id && p.occurrence == entry.occurrence);
        let automation_id = if adopt {
            entry.legacy_id.clone()
        } else {
            merge_entry(automations, &mut taken, prev, &entry, report)
        };
        records.push(LegacyEntryRecord {
            legacy_id: entry.legacy_id,
            occurrence: entry.occurrence,
            sha256: entry.sha256,
            updated_at: entry.updated_at,
            automation_id,
        });
    }
    Some(LegacyFileRecord {
        version,
        sha256,
        entries: records,
    })
}

/// Merge one legacy entry; returns the id of the automation it now maps to.
fn merge_entry(
    automations: &mut Vec<Automation>,
    taken: &mut HashSet<String>,
    prev: Option<&LegacyEntryRecord>,
    entry: &LegacyEntry,
    report: &mut LibraryReport,
) -> String {
    let mut incoming = entry.automation.clone();
    let wanted = match prev {
        Some(p) if p.sha256 == entry.sha256 => return p.automation_id.clone(),
        Some(p) => p.automation_id.clone(),
        None => entry.legacy_id.clone(),
    };
    report.merged += 1;
    if let Some(p) = prev {
        if let Some(existing) = automations.iter_mut().find(|a| a.id == p.automation_id) {
            if existing.updated_at == p.updated_at {
                incoming.id = wanted.clone();
                *existing = incoming;
                return wanted;
            }
            report.conflicts += 1;
            incoming.name.push_str(CONFLICT_SUFFIX);
            incoming.id = fresh_id(&entry.legacy_id, taken);
            let id = incoming.id.clone();
            taken.insert(id.clone());
            automations.push(incoming);
            return id;
        }
    }
    incoming.id = if taken.contains(&wanted) {
        fresh_id(&entry.legacy_id, taken)
    } else {
        wanted
    };
    let id = incoming.id.clone();
    taken.insert(id.clone());
    automations.push(incoming);
    id
}

/// The first `automation-<id>[-n]` not in `taken` (the same scheme as the
/// library conversion).
fn fresh_id(id: &str, taken: &HashSet<String>) -> String {
    let base = format!("{REID_PREFIX}{id}");
    let mut candidate = base.clone();
    let mut n = 2u32;
    while taken.contains(&candidate) {
        candidate = format!("{base}-{n}");
        n += 1;
    }
    candidate
}

/// Re-point `run-automation` steps at the automation a macro became.
fn follow_macro_ids(steps: &mut [AutomationStep], macro_ids: &HashMap<String, String>) {
    for step in steps {
        match step {
            AutomationStep::RunAutomation { automation_id, .. } => {
                if let Some(target) = macro_ids.get(automation_id.as_str()) {
                    automation_id.clone_from(target);
                }
            }
            AutomationStep::Conditional {
                then, otherwise, ..
            } => {
                follow_macro_ids(then, macro_ids);
                follow_macro_ids(otherwise, macro_ids);
            }
            AutomationStep::Loop { body, .. } => follow_macro_ids(body, macro_ids),
            _ => {}
        }
    }
}

/// Legacy id → automation id for the first entry with each id, where the id
/// changed.
fn record_id_map(record: &LegacyFileRecord) -> HashMap<String, String> {
    record
        .entries
        .iter()
        .filter(|e| e.occurrence == 1 && e.legacy_id != e.automation_id)
        .map(|e| (e.legacy_id.clone(), e.automation_id.clone()))
        .collect()
}

/// [`record_id_map`] of the store's `macros.json` record.
fn macro_id_map(store: &AutomationStore) -> HashMap<String, String> {
    store
        .migrated_from
        .as_ref()
        .and_then(|p| p.macros.as_ref())
        .map(record_id_map)
        .unwrap_or_default()
}

/// Count `id`'s occurrences so far, returning this one's number (from 1).
fn next_occurrence<'a>(seen: &mut HashMap<&'a str, u32>, id: &'a str) -> u32 {
    let counter = seen.entry(id).or_insert(0);
    *counter += 1;
    *counter
}

/// What the whole boot migration did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct BootReport {
    /// The library (`automations.json`) half.
    pub library: LibraryReport,
    /// The run-history (`automation-runs.json`) half.
    pub runs: super::migrate_runs::RunsReport,
}

/// Run the library and the run-history migration over the config directory
/// `dir`. Call before any automation, macro or workflow manager loads.
pub fn run_boot_migration(dir: &Path, now: chrono::DateTime<chrono::Utc>) -> Result<BootReport> {
    let library = migrate_library(dir).context("Failed to migrate macros and workflows")?;
    let runs = super::migrate_runs::migrate_runs(dir, &library.macro_ids, now)
        .context("Failed to migrate macro and workflow run history")?;
    Ok(BootReport { library, runs })
}

/// The recovery warning that reports merged-back changes, or `None` when
/// nothing was merged.
pub fn merge_warning(report: &LibraryReport) -> Option<RecoveryWarning> {
    if report.merged == 0 {
        return None;
    }
    let mut message = format!(
        "Automations: merged {} change{} made by an older termiHub version.",
        report.merged,
        if report.merged == 1 { "" } else { "s" }
    );
    if report.conflicts > 0 {
        message.push_str(&format!(
            " {} changed on both sides and kept as a copy named \"…{CONFLICT_SUFFIX}\".",
            report.conflicts
        ));
    }
    Some(RecoveryWarning {
        file_name: AutomationStore::FILE_NAME.to_string(),
        message,
        details: None,
    })
}

//! What the last restores left switched off, until the user has seen it (#6056).
//!
//! The list travels with a committed restore ([`RESTORED_OFF_FILE`] in the pending
//! directory) and reaches the config directory only when the restore was applied.
//! It holds names and switches, no content of the entries.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::sections::{self, CurrentDoc};
use super::self_starting::{still_off, RestoredStart};
use crate::utils::fs::write_atomic;

/// The list's file name, in the pending directory and in the config directory.
pub const RESTORED_OFF_FILE: &str = "restored-off.json";

#[derive(Debug, Default, Serialize, Deserialize)]
struct RestoredOff {
    #[serde(default)]
    entries: Vec<RestoredStart>,
}

fn read(path: &Path) -> Vec<RestoredStart> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    match serde_json::from_str::<RestoredOff>(&text) {
        Ok(list) => list.entries,
        Err(e) => {
            tracing::warn!("{} cannot be read: {e}", path.display());
            Vec::new()
        }
    }
}

fn write(path: &Path, entries: Vec<RestoredStart>) -> anyhow::Result<()> {
    write_atomic(
        path,
        &serde_json::to_string_pretty(&RestoredOff { entries })?,
    )
}

/// Put the list beside the staged files of a restore.
pub fn stage(staging: &Path, entries: &[RestoredStart]) -> anyhow::Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    write(&staging.join(RESTORED_OFF_FILE), entries.to_vec())
}

/// Take the list of an applied restore over, beside what an earlier one left. Best
/// effort: the entries are off either way.
pub fn promote(config_dir: &Path, pending: &Path) {
    let entries = read(&pending.join(RESTORED_OFF_FILE));
    if entries.is_empty() {
        return;
    }
    let path = config_dir.join(RESTORED_OFF_FILE);
    let mut all = read(&path);
    all.retain(|a| {
        !entries
            .iter()
            .any(|b| (&a.section, &a.id) == (&b.section, &b.id))
    });
    all.extend(entries);
    if let Err(e) = write(&path, all) {
        tracing::warn!("Could not keep the list of what the restore left off: {e:#}");
    }
}

/// What is still off, as the stores are now. An entry that was turned on, or that is
/// gone, is not listed. One of the old workflow file is listed as the automation it
/// became.
pub fn list(config_dir: &Path) -> Vec<RestoredStart> {
    let doc = |section: &str| match sections::spec(section)
        .map(|spec| sections::read_current(spec, config_dir))
    {
        Some(CurrentDoc::Present(doc)) => doc,
        _ => Value::Null,
    };
    let automations = doc("automations");
    let mut out: Vec<RestoredStart> = Vec::new();
    for mut entry in read(&config_dir.join(RESTORED_OFF_FILE)) {
        if entry.section == "workflows" {
            entry.section = "automations".to_string();
            entry.id = automation_of(&automations, &entry.id);
        }
        let known = out
            .iter()
            .any(|o| (&o.section, &o.id) == (&entry.section, &entry.id));
        let off = if entry.section == "automations" {
            still_off(&automations, &entry)
        } else {
            still_off(&doc(&entry.section), &entry)
        };
        if off && !known {
            out.push(entry);
        }
    }
    out
}

/// The automation a workflow with this id became.
fn automation_of(automations: &Value, id: &str) -> String {
    automations["idRemaps"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|r| r["source"] == "workflow" && r["oldId"] == id)
        .and_then(|r| r["newId"].as_str())
        .unwrap_or(id)
        .to_string()
}

/// The user has seen the list.
pub fn dismiss(config_dir: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(config_dir.join(RESTORED_OFF_FILE)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

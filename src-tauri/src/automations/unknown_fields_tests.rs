//! A file written by a newer build survives every write by this one (#6009):
//! unknown keys at every level, unknown step and trigger kinds, and automations
//! this build cannot read at all.

use std::fs;

use serde_json::{json, Value};
use tempfile::TempDir;

use super::config::Automation;
use super::manager::AutomationManager;
use super::migrate::run_boot_migration;
use super::storage::StoreFile;
use super::store::AutomationStore;
use crate::backup::sections;

const FILE: &str = "automations.json";

/// An automation with unknown keys at every level, and steps and a trigger of
/// kinds this build does not know. The frontend's round trip reads it too.
fn newer() -> Value {
    serde_json::from_str(include_str!("testdata/newer.json")).unwrap()
}

/// An automation with a value this build cannot read (a new typing speed).
fn unreadable() -> Value {
    json!({"id": "unreadable", "name": "Unreadable", "tags": [],
        "steps": [{"kind": "type-keys", "timing": "turbo", "chunks": []}],
        "triggers": [{"kind": "on-connect", "connectionIds": ["c1"]}],
        "createdAt": "c", "updatedAt": "u", "fAutomation": 1})
}

fn plain(id: &str) -> Value {
    json!({"id": id, "name": id, "tags": [], "steps": [], "triggers": [],
        "createdAt": "2026-01-01T00:00:00+00:00", "updatedAt": "u"})
}

fn doc() -> Value {
    json!({"version": "1", "automations": [plain("first"), unreadable(), newer(), plain("last")],
        "legacyFrozenAt": "2026-01-01T00:00:00+00:00", "fTop": {"keep": [true]}})
}

fn dir_with(doc: &Value) -> TempDir {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join(FILE), doc.to_string()).unwrap();
    dir
}

fn manager(dir: &TempDir) -> AutomationManager {
    AutomationManager::with_storage(StoreFile::in_dir(dir.path())).unwrap()
}

fn on_disk(dir: &TempDir) -> Value {
    serde_json::from_str(&fs::read_to_string(dir.path().join(FILE)).unwrap()).unwrap()
}

fn entry<'a>(doc: &'a mut Value, id: &str) -> &'a mut Value {
    doc["automations"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|a| a["id"] == id)
        .unwrap()
}

/// `doc` with the update time of `id` masked: a save stamps it.
fn masked(mut doc: Value, id: &str) -> Value {
    entry(&mut doc, id)["updatedAt"] = Value::Null;
    doc
}

/// What the IPC hop hands the frontend, and takes back.
fn over_ipc(automation: Automation) -> Value {
    serde_json::to_value(automation).unwrap()
}

#[test]
fn loading_does_not_touch_the_file() {
    let dir = dir_with(&doc());
    let before = fs::read(dir.path().join(FILE)).unwrap();
    let m = manager(&dir);
    run_boot_migration(dir.path(), chrono::Utc::now()).unwrap();
    assert!(m.list().is_ok());
    drop(m);
    let after = fs::read(dir.path().join(FILE)).unwrap();
    // The first boot records the (absent) legacy files; the automations and
    // every unknown key are as they were.
    let mut after: Value = serde_json::from_slice(&after).unwrap();
    after.as_object_mut().unwrap().remove("migratedFrom");
    let before: Value = serde_json::from_slice(&before).unwrap();
    assert_eq!(after, before);
    assert!(
        !dir.path().join("automations.json.bak").exists(),
        "nothing was corrupt"
    );
}

#[test]
fn the_frontend_gets_every_unknown_field() {
    let dir = dir_with(&doc());
    let m = manager(&dir);
    assert_eq!(over_ipc(m.get("newer").unwrap()), newer());
}

#[test]
fn an_edit_keeps_everything_it_does_not_change() {
    let dir = dir_with(&doc());
    let m = manager(&dir);
    let mut edited = over_ipc(m.get("newer").unwrap());
    edited["name"] = json!("Renamed");
    edited["tags"] = json!(["a", "b"]);
    edited["triggersEnabled"] = json!(true);
    m.save(serde_json::from_value(edited).unwrap()).unwrap();

    let mut expected = doc();
    let e = entry(&mut expected, "newer");
    e["name"] = json!("Renamed");
    e["tags"] = json!(["a", "b"]);
    e.as_object_mut().unwrap().remove("triggersEnabled");
    assert_eq!(masked(on_disk(&dir), "newer"), masked(expected, "newer"));
}

#[test]
fn a_save_that_does_not_send_the_unknown_fields_keeps_those_of_the_automation() {
    let dir = dir_with(&doc());
    let m = manager(&dir);
    let mut edited = over_ipc(m.get("newer").unwrap());
    let obj = edited.as_object_mut().unwrap();
    obj.remove("fAutomation");
    obj.remove("fFlag");
    m.save(serde_json::from_value(edited).unwrap()).unwrap();
    assert_eq!(masked(on_disk(&dir), "newer"), masked(doc(), "newer"));
}

#[test]
fn saving_and_deleting_another_automation_keep_the_rest() {
    let dir = dir_with(&doc());
    let m = manager(&dir);
    let mut first = over_ipc(m.get("first").unwrap());
    first["name"] = json!("First");
    m.save(serde_json::from_value(first).unwrap()).unwrap();
    let mut expected = doc();
    entry(&mut expected, "first")["name"] = json!("First");
    assert_eq!(
        masked(on_disk(&dir), "first"),
        masked(expected.clone(), "first")
    );

    m.delete("last").unwrap();
    expected["automations"].as_array_mut().unwrap().pop();
    assert_eq!(masked(on_disk(&dir), "first"), masked(expected, "first"));
}

#[test]
fn a_copy_and_an_import_add_to_the_file_and_change_nothing_else() {
    let dir = dir_with(&doc());
    let m = manager(&dir);
    let mut copy = over_ipc(m.get("newer").unwrap());
    copy["id"] = json!("copy");
    copy["createdAt"] = json!("");
    copy.as_object_mut().unwrap().remove("legacy");
    m.save(serde_json::from_value(copy).unwrap()).unwrap();
    m.save(serde_json::from_value(plain("imported")).unwrap())
        .unwrap();

    let mut disk = on_disk(&dir);
    let mut copied = entry(&mut disk, "copy").clone();
    let list = disk["automations"].as_array_mut().unwrap();
    list.truncate(list.len() - 2);
    assert_eq!(disk, doc());
    // A copy carries the unknown fields too.
    for (key, stored) in [("id", "newer"), ("createdAt", "2026-01-01T00:00:00+00:00")] {
        copied[key] = json!(stored);
    }
    copied["updatedAt"] = newer()["updatedAt"].clone();
    copied["legacy"] = newer()["legacy"].clone();
    assert_eq!(copied, newer());
}

#[test]
fn a_connection_rename_follows_known_and_unknown_triggers() {
    let dir = dir_with(&doc());
    let m = manager(&dir);
    let change = crate::connection::id_changes::ConnectionIdChange::new("c1", "moved/c1");
    let remap = crate::connection::id_changes::ConnectionIdRemap::new(&[change]);
    assert!(m.follow_connection_id_changes(&remap).unwrap());
    let expected: Value =
        serde_json::from_str(&doc().to_string().replace("\"c1\"", "\"moved/c1\"")).unwrap();
    assert_eq!(on_disk(&dir), expected);
}

#[test]
fn a_backup_and_restore_keep_everything() {
    let spec = sections::spec("automations").unwrap();
    assert_eq!(spec.normalize(doc()).unwrap(), doc());
}

#[test]
fn the_reconcile_pass_keeps_everything() {
    let dir = dir_with(&doc());
    run_boot_migration(dir.path(), chrono::Utc::now()).unwrap();
    // An older build adds a macro whose id is taken by the unreadable one.
    let macros = json!({"version": "1", "macros": [{"id": "unreadable", "name": "Old", "tags": [],
        "steps": [{"data": "x", "delayMs": 1}], "createdAt": "c", "updatedAt": "u"}]});
    fs::write(dir.path().join("macros.json"), macros.to_string()).unwrap();
    run_boot_migration(dir.path(), chrono::Utc::now()).unwrap();

    let mut disk = on_disk(&dir);
    disk.as_object_mut().unwrap().remove("migratedFrom");
    let list = disk["automations"].as_array_mut().unwrap();
    let added = list.pop().unwrap();
    assert_eq!(added["id"], "automation-unreadable", "the id stays unique");
    assert_eq!(disk, doc());
}

#[test]
fn an_unreadable_automation_is_kept_reported_and_not_offered() {
    let dir = dir_with(&doc());
    let m = manager(&dir);
    let ids: Vec<String> = m.list().unwrap().into_iter().map(|a| a.id).collect();
    assert_eq!(ids, ["first", "newer", "last"]);
    assert!(m.get("unreadable").is_err());
    let warnings = m.take_recovery_warnings();
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert!(warnings[0].message.contains("\"Unreadable\""));
    assert!(warnings[0].message.contains("kept"));
    // Its id cannot be taken over.
    let taken = serde_json::from_value(plain("unreadable")).unwrap();
    assert!(m.save(taken).is_err());
    assert_eq!(on_disk(&dir), doc());
}

#[test]
fn entries_that_are_no_automation_are_still_salvaged() {
    let mut broken = doc();
    broken["automations"]
        .as_array_mut()
        .unwrap()
        .push(json!(42));
    let dir = dir_with(&broken);
    let m = manager(&dir);
    assert_eq!(m.list().unwrap().len(), 3);
    assert_eq!(on_disk(&dir), doc(), "only the broken entry is gone");
}

/// A known kind with a missing field is not an unknown kind: it must not be
/// shown or run with the field missing.
#[test]
fn a_malformed_known_step_does_not_pass_as_an_unknown_kind() {
    let mut bad = plain("bad");
    bad["steps"] = json!([{"kind": "send-command"}]);
    let dir = dir_with(&json!({"version": "1", "automations": [bad]}));
    let before = on_disk(&dir);
    let m = manager(&dir);
    assert!(m.list().unwrap().is_empty());
    m.save(serde_json::from_value(plain("new")).unwrap())
        .unwrap();
    assert_eq!(on_disk(&dir)["automations"][0], before["automations"][0]);
}

#[test]
fn legacy_entries_carry_their_unknown_fields_over() {
    let dir = TempDir::new().unwrap();
    let macros = json!({"version": "1", "macros": [{"id": "m", "name": "m", "tags": [],
        "steps": [{"data": "x", "delayMs": 1, "fChunk": 1}], "fMacro": {"a": 1},
        "createdAt": "c", "updatedAt": "u"}]});
    let workflows = json!({"version": "3", "workflows": [{"id": "w", "name": "w", "tags": [],
        "steps": [{"kind": "run-macro", "macroId": "m", "fStep": 1},
                  {"kind": "loop", "loop": {"kind": "count", "count": 1},
                   "body": [{"kind": "wait", "delayMs": 1, "fNested": 2}]}],
        "triggers": [{"kind": "manual"}, {"kind": "hotkey", "binding": "b", "fTrigger": 1}],
        "parameters": [{"name": "p", "type": "string", "fParam": 1}],
        "fWorkflow": true, "createdAt": "c", "updatedAt": "u"}]});
    fs::write(dir.path().join("macros.json"), macros.to_string()).unwrap();
    fs::write(dir.path().join("workflows.json"), workflows.to_string()).unwrap();
    run_boot_migration(dir.path(), chrono::Utc::now()).unwrap();
    let mut disk = on_disk(&dir);
    let m = entry(&mut disk, "m").clone();
    assert_eq!(m["fMacro"], json!({"a": 1}));
    assert_eq!(m["steps"][0]["chunks"][0]["fChunk"], 1);
    let w = entry(&mut disk, "w").clone();
    assert_eq!(w["fWorkflow"], true);
    assert_eq!(w["steps"][0]["fStep"], 1);
    assert_eq!(w["steps"][1]["body"][0]["fNested"], 2);
    assert_eq!(
        w["triggers"],
        json!([{"kind": "hotkey", "binding": "b", "fTrigger": 1}])
    );
    assert_eq!(w["parameters"][0]["fParam"], 1);
}

#[test]
fn a_store_round_trips_as_is() {
    let store: AutomationStore = serde_json::from_value(doc()).unwrap();
    assert_eq!(serde_json::to_value(&store).unwrap(), doc());
}

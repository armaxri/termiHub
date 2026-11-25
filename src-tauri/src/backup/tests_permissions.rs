//! A restore never grants what may run on this machine (#6018, #6019).

use std::path::Path;

use serde_json::{json, Value};

use super::restore;
use super::sections::{self, LOCAL_PERMISSION_KEYS, SECTIONS};
use super::tests::{choice, no_creds, raw_backup, request, restore_and_boot, write_doc};
use super::*;
use crate::automations::manager::AutomationManager;
use crate::automations::storage::StoreFile;
use crate::automations::trust::{AutomationTrust, Standing};
use crate::connection::settings::AppSettings;
use crate::credential::vault::ConflictStrategy;
use crate::utils::migrate::VersionedStore;

fn section(id: &str, data: Value) -> BackupSection {
    BackupSection {
        id: id.into(),
        schema_version: sections::spec(id).unwrap().current_version,
        data,
    }
}

/// A settings section with every permission given.
fn generous() -> BackupSection {
    section(
        "settings",
        json!({
            "version": <AppSettings as VersionedStore>::CURRENT_VERSION.to_string(),
            "theme": "dark",
            "experimentalFeaturesEnabled": true,
            "frontendPluginsEnabled": true,
            "workflowLocalProcessEnabled": true,
            "workflowLocalProcessAllowlist": ["/bin/sh", "/usr/bin/make"],
            "workflowScriptSourceAllowlist": ["/tmp/x.sh"],
            "workspaceImportAllowlist": ["key"],
        }),
    )
}

fn replace(id: &str) -> BackupRestoreRequest {
    request(vec![choice(
        id,
        RestoreMode::Replace,
        ConflictStrategy::Skip,
    )])
}

fn settings(dir: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap()
}

#[test]
fn every_permission_key_is_a_setting() {
    let all = serde_json::to_value(AppSettings {
        experimental_features_enabled: Some(true),
        frontend_plugins_enabled: Some(true),
        workflow_local_process_enabled: true,
        workflow_local_process_allowlist: vec!["a".into()],
        workflow_script_source_allowlist: vec!["a".into()],
        workspace_import_allowlist: vec!["a".into()],
        ..AppSettings::default()
    })
    .unwrap();
    for key in LOCAL_PERMISSION_KEYS {
        assert!(all.get(*key).is_some(), "{key}");
    }
}

#[test]
fn a_first_restore_on_a_new_machine_leaves_every_permission_off() {
    let dir = tempfile::tempdir().unwrap();
    restore_and_boot(
        &raw_backup(vec![generous()], BACKUP_FORMAT_VERSION),
        dir.path(),
        &replace("settings"),
    );
    let doc = settings(dir.path());
    assert_eq!(doc["theme"], "dark", "the rest is restored");
    let loaded: AppSettings = serde_json::from_value(doc).unwrap();
    assert_eq!(loaded.experimental_features_enabled, None);
    assert_eq!(loaded.frontend_plugins_enabled, None);
    assert!(!loaded.workflow_local_process_enabled);
    assert!(loaded.workflow_local_process_allowlist.is_empty());
    assert!(loaded.workflow_script_source_allowlist.is_empty());
    assert!(loaded.workspace_import_allowlist.is_empty());
}

#[test]
fn a_restore_neither_adds_to_nor_takes_from_what_this_machine_allows() {
    let mine = json!({
        "version": <AppSettings as VersionedStore>::CURRENT_VERSION.to_string(),
        "theme": "light",
        "experimentalFeaturesEnabled": true,
        "frontendPluginsEnabled": false,
        "workflowLocalProcessEnabled": true,
        "workflowLocalProcessAllowlist": ["/usr/bin/true"],
        "workflowScriptSourceAllowlist": ["/mine.sh"],
        "workspaceImportAllowlist": ["mine"],
    });
    let mut off = generous();
    for key in LOCAL_PERMISSION_KEYS {
        off.data.as_object_mut().unwrap().remove(*key);
    }
    for backup in [generous(), off] {
        let dir = tempfile::tempdir().unwrap();
        write_doc(dir.path(), "settings.json", &mine);
        restore_and_boot(
            &raw_backup(vec![backup], BACKUP_FORMAT_VERSION),
            dir.path(),
            &replace("settings"),
        );
        let doc = settings(dir.path());
        assert_eq!(doc["theme"], "dark");
        for key in LOCAL_PERMISSION_KEYS {
            assert_eq!(doc[*key], mine[*key], "{key}");
        }
    }
}

fn notes(backup: Vec<BackupSection>, id: &str) -> Vec<String> {
    let dir = tempfile::tempdir().unwrap();
    let opened = restore::open(&raw_backup(backup, BACKUP_FORMAT_VERSION), None).unwrap();
    let preview = restore::plan(&opened, dir.path(), no_creds);
    preview
        .sections
        .into_iter()
        .find(|s| s.id == id)
        .unwrap()
        .notes
}

#[test]
fn the_preview_says_what_is_kept_and_what_the_backup_would_have_allowed() {
    let generous = notes(vec![generous()], "settings");
    assert!(generous[0].contains("stays as it is here"), "{generous:?}");
    assert!(
        generous[1].contains(
            "experimental features turned on, JavaScript plugins turned on, running local programs turned on, \
             2 allowed programs, 1 allowed script file, 1 confirmed workspace command"
        ),
        "{generous:?}"
    );
    let version = <AppSettings as VersionedStore>::CURRENT_VERSION.to_string();
    let plain = notes(
        vec![section(
            "settings",
            json!({ "version": version, "theme": "dark" }),
        )],
        "settings",
    );
    assert_eq!(plain.len(), 1, "{plain:?}");
}

fn library(automations: Value) -> BackupSection {
    section(
        "automations",
        json!({ "version": "1", "automations": automations }),
    )
}

fn runs(id: &str, arg: &str) -> Value {
    json!({ "id": id, "name": id, "steps": [
        { "kind": "loop", "loop": { "kind": "count", "count": 1 }, "body": [
            { "kind": "run-local-process", "program": "make", "args": [arg] }
        ] }
    ] })
}

#[test]
fn the_preview_says_that_restored_automations_ask() {
    let with = notes(vec![library(json!([runs("a", "x")]))], "automations");
    assert!(with[0].contains("ask before they first run"), "{with:?}");
    let typing = json!([{ "id": "a", "name": "a", "steps": [
        { "kind": "send-command", "command": "run-local-process" }
    ] }]);
    assert!(notes(vec![library(typing)], "automations").is_empty());
}

#[test]
fn a_restored_automation_asks_unless_it_is_the_one_made_here() {
    let dir = tempfile::tempdir().unwrap();
    let manager =
        || AutomationManager::with_storage(StoreFile::in_dir(dir.path())).expect("the store loads");
    let m = manager();
    for id in ["same", "changed"] {
        m.save(serde_json::from_value(runs(id, "mine")).unwrap())
            .unwrap();
    }
    drop(m);
    restore_and_boot(
        &raw_backup(
            vec![library(json!([
                runs("same", "mine"),
                runs("changed", "evil"),
                runs("new", "evil")
            ]))],
            BACKUP_FORMAT_VERSION,
        ),
        dir.path(),
        &replace("automations"),
    );
    let m = manager();
    let standing = |id: &str, arg: &str| {
        m.standing(
            &[id.to_string()],
            "make",
            &[arg.to_string()],
            Path::new("/usr/bin/make"),
        )
    };
    assert_eq!(standing("same", "mine"), Standing::Own);
    for id in ["changed", "new"] {
        assert_eq!(
            standing(id, "evil"),
            Standing::Unconfirmed {
                names: vec![id.to_string()]
            }
        );
    }
}

#[test]
fn what_is_trusted_here_is_in_no_backup() {
    assert!(SECTIONS
        .iter()
        .all(|s| s.file_name != AutomationTrust::FILE_NAME));
}

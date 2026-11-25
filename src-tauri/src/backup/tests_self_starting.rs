//! What a restore brings starts nothing by itself on this machine (#6056).

use std::path::Path;

use serde_json::{json, Value};

use super::sections::spec;
use super::tests::{choice, raw_backup, read_doc, request, restore_and_boot, write_doc};
use super::*;
use crate::credential::vault::ConflictStrategy;

fn doc(id: &str, field: &str, items: Value) -> Value {
    let mut doc = spec(id).unwrap().default_doc();
    doc[field] = items;
    doc
}

fn section(id: &str, field: &str, items: Value) -> BackupSection {
    BackupSection {
        id: id.into(),
        schema_version: spec(id).unwrap().current_version,
        data: doc(id, field, items),
    }
}

/// Write a section's file as this machine has it.
fn here(dir: &Path, id: &str, field: &str, items: Value) {
    write_doc(dir, spec(id).unwrap().file_name, &doc(id, field, items));
}

fn restore_as(
    dir: &Path,
    sections: Vec<BackupSection>,
    mode: RestoreMode,
    conflicts: ConflictStrategy,
) -> BackupRestoreResult {
    let choices = sections
        .iter()
        .map(|s| choice(&s.id, mode, conflicts))
        .collect();
    restore_and_boot(
        &raw_backup(sections, BACKUP_FORMAT_VERSION),
        dir,
        &request(choices),
    )
}

fn replace(dir: &Path, sections: Vec<BackupSection>) -> BackupRestoreResult {
    restore_as(dir, sections, RestoreMode::Replace, ConflictStrategy::Skip)
}

/// The item of a section's file with this id.
fn item(dir: &Path, id: &str, field: &str, item: &str) -> Value {
    read_doc(dir, spec(id).unwrap().file_name)[field]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"] == item)
        .cloned()
        .unwrap_or(Value::Null)
}

fn schedule(id: &str) -> Value {
    json!({
        "id": id, "name": "Nightly",
        "action": {"kind": "automation", "automationId": "a"},
        "targets": {"kind": "connections", "connectionIds": ["Build Box"]},
        "rule": {"kind": "daily", "time": "02:00"},
        "missedRuns": "run-once", "connectIfNeeded": true, "enabled": true,
        "confirmedAt": "2026-01-01T00:00:00+00:00", "enabledAt": "2026-01-01T00:00:00+00:00",
        "lastRunAt": "2026-01-02T00:00:00+00:00", "createdAt": "c", "updatedAt": "u"
    })
}

fn automation(id: &str, command: &str) -> Value {
    json!({
        "id": id, "name": format!("Automation {id}"),
        "steps": [{"kind": "send-command", "command": command}],
        "triggers": [
            {"kind": "hotkey", "binding": "Ctrl+Alt+R"},
            {"kind": "on-connect", "connectionIds": ["Build Box"]}
        ]
    })
}

fn tunnel(id: &str) -> Value {
    json!({
        "id": id, "name": "DB", "sshConnectionId": "Build Box",
        "tunnelType": {"type": "local", "config": {"localHost": "127.0.0.1", "localPort": 5432,
            "remoteHost": "db", "remotePort": 5432}},
        "autoStart": true, "startWithConnection": true, "reconnectOnDisconnect": true
    })
}

fn server(id: &str) -> Value {
    json!({
        "id": id, "name": "Share", "serverType": "http", "rootDirectory": "/srv",
        "bindHost": "0.0.0.0", "port": 8080, "autoStart": true
    })
}

#[test]
fn a_restored_schedule_is_off_and_unconfirmed() {
    let dir = tempfile::tempdir().unwrap();
    replace(
        dir.path(),
        vec![section("schedules", "schedules", json!([schedule("s")]))],
    );
    let restored = item(dir.path(), "schedules", "schedules", "s");
    assert_eq!(restored["enabled"], false);
    assert_eq!(restored["confirmedAt"], Value::Null);
    assert_eq!(restored["enabledAt"], Value::Null);
    assert_eq!(restored["connectIfNeeded"], true, "the rest is restored");
}

#[test]
fn a_restored_automation_has_its_triggers_off() {
    let dir = tempfile::tempdir().unwrap();
    replace(
        dir.path(),
        vec![section(
            "automations",
            "automations",
            json!([
                automation("a", "ls"),
                {"id": "b", "name": "B", "steps": [], "triggers": []}
            ]),
        )],
    );
    let restored = item(dir.path(), "automations", "automations", "a");
    assert_eq!(restored["triggersEnabled"], false);
    assert_eq!(restored["triggers"].as_array().unwrap().len(), 2);
    let without = item(dir.path(), "automations", "automations", "b");
    assert!(without.get("triggersEnabled").is_none(), "{without}");
}

#[test]
fn the_triggers_of_a_restored_old_workflow_file_are_off() {
    let dir = tempfile::tempdir().unwrap();
    replace(
        dir.path(),
        vec![section(
            "workflows",
            "workflows",
            json!([automation("w", "ls")]),
        )],
    );
    let restored = item(dir.path(), "workflows", "workflows", "w");
    assert_eq!(restored["triggersEnabled"], false);
}

#[test]
fn a_restored_tunnel_and_file_server_do_not_start_by_themselves() {
    let dir = tempfile::tempdir().unwrap();
    replace(
        dir.path(),
        vec![
            section("tunnels", "tunnels", json!([tunnel("t")])),
            section("embeddedServers", "servers", json!([server("f")])),
        ],
    );
    let tunnel = item(dir.path(), "tunnels", "tunnels", "t");
    assert_eq!(tunnel["autoStart"], false);
    assert_eq!(tunnel["startWithConnection"], false);
    assert_eq!(tunnel["reconnectOnDisconnect"], true);
    let server = item(dir.path(), "embeddedServers", "servers", "f");
    assert_eq!(server["autoStart"], false);
    assert_eq!(server["bindHost"], "0.0.0.0");
}

fn workspace(command: &str) -> Value {
    json!({
        "id": "w", "name": "Dev", "tabGroups": [{"name": "G", "layout": {
            "type": "leaf", "tabs": [{"title": "T", "connectionRef": "Build Box",
                "initialCommand": command}]
        }}]
    })
}

fn tab(dir: &Path) -> Value {
    item(dir, "workspaces", "workspaces", "w")["tabGroups"][0]["layout"]["tabs"][0].clone()
}

#[test]
fn a_restored_workspace_command_waits_for_confirmation() {
    let dir = tempfile::tempdir().unwrap();
    replace(
        dir.path(),
        vec![section(
            "workspaces",
            "workspaces",
            json!([workspace("make")]),
        )],
    );
    let tab = tab(dir.path());
    assert_eq!(tab["initialCommand"], Value::Null, "{tab}");
    assert_eq!(tab["pendingInitialCommand"], "make");
}

#[test]
fn what_is_on_here_and_unchanged_stays_as_it_is() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let mut mine = schedule("s");
    mine["lastRunAt"] = json!("2026-06-01T00:00:00+00:00");
    here(d, "schedules", "schedules", json!([mine]));
    here(
        d,
        "automations",
        "automations",
        json!([automation("a", "ls")]),
    );
    here(d, "tunnels", "tunnels", json!([tunnel("t")]));
    here(d, "embeddedServers", "servers", json!([server("f")]));
    here(d, "workspaces", "workspaces", json!([workspace("make")]));
    let mut renamed = schedule("s");
    renamed["name"] = json!("Renamed in the backup");
    replace(
        d,
        vec![
            section("schedules", "schedules", json!([renamed])),
            section("automations", "automations", json!([automation("a", "ls")])),
            section("tunnels", "tunnels", json!([tunnel("t")])),
            section("embeddedServers", "servers", json!([server("f")])),
            section("workspaces", "workspaces", json!([workspace("make")])),
        ],
    );
    let schedule = item(d, "schedules", "schedules", "s");
    assert_eq!(schedule["enabled"], true);
    assert_eq!(schedule["confirmedAt"], "2026-01-01T00:00:00+00:00");
    assert_eq!(schedule["name"], "Renamed in the backup");
    // What ran is this machine's: an older time would make it catch up at once.
    assert_eq!(schedule["lastRunAt"], "2026-06-01T00:00:00+00:00");
    let automation = item(d, "automations", "automations", "a");
    assert!(automation.get("triggersEnabled").is_none());
    let tunnel = item(d, "tunnels", "tunnels", "t");
    assert_eq!(tunnel["autoStart"], true);
    assert_eq!(tunnel["startWithConnection"], true);
    assert_eq!(
        item(d, "embeddedServers", "servers", "f")["autoStart"],
        true
    );
    assert_eq!(tab(d)["initialCommand"], "make");
}

/// Each change of what an entry does, or of when it starts, turns it off.
#[test]
fn what_is_on_here_but_different_in_the_backup_is_off() {
    let change = |mut item: Value, path: &str, value: Value| {
        *item.pointer_mut(path).unwrap() = value;
        item
    };
    for (id, field, here_item, restored, flag) in [
        (
            "schedules",
            "schedules",
            schedule("x"),
            change(schedule("x"), "/targets/connectionIds/0", json!("Other")),
            "enabled",
        ),
        (
            "schedules",
            "schedules",
            schedule("x"),
            change(schedule("x"), "/rule/time", json!("03:00")),
            "enabled",
        ),
        (
            "automations",
            "automations",
            automation("x", "ls"),
            automation("x", "rm -r"),
            "triggersEnabled",
        ),
        (
            "automations",
            "automations",
            automation("x", "ls"),
            change(automation("x", "ls"), "/triggers/0/binding", json!("F9")),
            "triggersEnabled",
        ),
        (
            "tunnels",
            "tunnels",
            tunnel("x"),
            change(tunnel("x"), "/tunnelType/config/remoteHost", json!("evil")),
            "autoStart",
        ),
        (
            "embeddedServers",
            "servers",
            server("x"),
            change(server("x"), "/rootDirectory", json!("/")),
            "autoStart",
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        here(dir.path(), id, field, json!([here_item]));
        replace(dir.path(), vec![section(id, field, json!([restored]))]);
        assert_eq!(item(dir.path(), id, field, "x")[flag], false, "{id}");
    }
}

#[test]
fn what_is_off_here_is_not_turned_on() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let mut off = schedule("s");
    off["enabled"] = json!(false);
    here(d, "schedules", "schedules", json!([off]));
    let mut disarmed = automation("a", "ls");
    disarmed["triggersEnabled"] = json!(false);
    here(d, "automations", "automations", json!([disarmed]));
    let mut half = tunnel("t");
    half["autoStart"] = json!(false);
    here(d, "tunnels", "tunnels", json!([half]));
    replace(
        d,
        vec![
            section("schedules", "schedules", json!([schedule("s")])),
            section("automations", "automations", json!([automation("a", "ls")])),
            section("tunnels", "tunnels", json!([tunnel("t")])),
        ],
    );
    assert_eq!(item(d, "schedules", "schedules", "s")["enabled"], false);
    let automation = item(d, "automations", "automations", "a");
    assert_eq!(automation["triggersEnabled"], false);
    let tunnel = item(d, "tunnels", "tunnels", "t");
    assert_eq!(tunnel["autoStart"], false);
    assert_eq!(tunnel["startWithConnection"], true, "this one was on here");
}

/// Something on here starts something the restore changed.
#[test]
fn what_is_on_here_is_turned_off_when_what_it_starts_was_changed() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let calls = json!({
        "id": "caller", "name": "Caller",
        "steps": [{"kind": "loop", "loop": {"kind": "count", "count": 1},
            "body": [{"kind": "run-automation", "automationId": "a"}]}],
        "triggers": [{"kind": "hotkey", "binding": "F8"}]
    });
    let mut plain = automation("a", "ls");
    plain["triggers"] = json!([]);
    here(d, "automations", "automations", json!([plain, calls]));
    here(d, "schedules", "schedules", json!([schedule("s")]));
    let mut changed = automation("a", "rm -r");
    changed["triggers"] = json!([]);
    // Only the automations are restored, and only one of them.
    restore_as(
        d,
        vec![section("automations", "automations", json!([changed]))],
        RestoreMode::Merge,
        ConflictStrategy::Overwrite,
    );
    assert_eq!(
        item(d, "automations", "automations", "caller")["triggersEnabled"],
        false
    );
    assert_eq!(item(d, "schedules", "schedules", "s")["enabled"], false);
}

#[test]
fn what_is_on_here_is_turned_off_when_its_connection_was_changed() {
    let connections = |host: &str| {
        json!([{"type": "connection", "name": "Build Box",
            "config": {"type": "ssh", "config": {"host": host, "username": "u"}}}])
    };
    for (host, on) in [("same.example", true), ("evil.example", false)] {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        here(d, "connections", "children", connections("same.example"));
        here(d, "schedules", "schedules", json!([schedule("s")]));
        here(
            d,
            "automations",
            "automations",
            json!([automation("a", "ls")]),
        );
        here(d, "tunnels", "tunnels", json!([tunnel("t")]));
        restore_as(
            d,
            vec![section("connections", "children", connections(host))],
            RestoreMode::Merge,
            ConflictStrategy::Overwrite,
        );
        assert_eq!(item(d, "schedules", "schedules", "s")["enabled"], on);
        let armed = item(d, "automations", "automations", "a")["triggersEnabled"] != false;
        assert_eq!(armed, on, "{host}");
        let tunnel = item(d, "tunnels", "tunnels", "t");
        assert_eq!(tunnel["autoStart"], on);
    }
}

#[test]
fn the_pause_of_this_machine_stays() {
    let dir = tempfile::tempdir().unwrap();
    let mut mine = doc("schedules", "schedules", json!([schedule("s")]));
    mine["paused"] = json!(true);
    write_doc(dir.path(), "schedules.json", &mine);
    replace(
        dir.path(),
        vec![section("schedules", "schedules", json!([schedule("s")]))],
    );
    assert_eq!(read_doc(dir.path(), "schedules.json")["paused"], true);
}

#[test]
fn a_merge_that_keeps_mine_changes_nothing_here() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    here(d, "schedules", "schedules", json!([schedule("s")]));
    let mut other = schedule("s");
    other["rule"]["time"] = json!("05:00");
    restore_as(
        d,
        vec![section(
            "schedules",
            "schedules",
            json!([other, schedule("new")]),
        )],
        RestoreMode::Merge,
        ConflictStrategy::Skip,
    );
    let mine = item(d, "schedules", "schedules", "s");
    assert_eq!(mine["enabled"], true);
    assert_eq!(mine["rule"]["time"], "02:00");
    assert_eq!(item(d, "schedules", "schedules", "new")["enabled"], false);
}

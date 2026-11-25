//! What a restore brings starts nothing by itself on this machine (#6056).
//!
//! A schedule, an automation's triggers, a tunnel or a file server that starts with
//! termiHub were switched on on the machine the backup came from. Here they arrive
//! switched off, like an import, and the user is told which ones and turns on what
//! they want ([`RestoredStart`], [`super::restored_off`]).
//!
//! What is on here and stays the same keeps running: the same entry, the same
//! automations it runs and the same connections it uses, compared over every section
//! of the restore at once. So an entry of this machine is also switched off, in a
//! section that was not even chosen, when the restore changes what it starts.
//!
//! A workspace starts nothing by itself, but types its commands when it is opened.
//! A restored one that is not the one here holds them back until they are confirmed,
//! as an imported one does (#4434).

use std::collections::{BTreeSet, HashMap};
use std::path::Path;

use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use zeroize::Zeroizing;

use super::sections::{self, CurrentDoc};
use crate::schedules::config::ScheduleRule;
use crate::schedules::timing::next_run_after;
use crate::workspace::config::WorkspaceTabGroupDef;
use crate::workspace::import_trust::mark_groups_untrusted;

/// An entry that a restore leaves switched off.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct RestoredStart {
    /// The section it is in.
    pub section: String,
    /// The entry's id.
    pub id: String,
    /// Its name.
    pub name: String,
    /// What would start it, one line each: "Hotkey Ctrl+Alt+R".
    pub starts: Vec<String>,
    /// When a schedule would run next.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub next_run_at: Option<String>,
    /// The switches of it that were turned off.
    pub switches: Vec<String>,
    /// An entry with this id is here now.
    pub exists_here: bool,
    /// It is on here now: the restore changes it, or what it starts.
    pub on_here: bool,
}

/// A section whose entries can start by themselves.
struct Starter {
    section: &'static str,
    list: &'static str,
    /// Its switches; `true` is on. `triggersEnabled` is on when absent.
    switches: &'static [&'static str],
}

const STARTERS: &[Starter] = &[
    Starter {
        section: "schedules",
        list: "schedules",
        switches: &["enabled"],
    },
    Starter {
        section: "automations",
        list: "automations",
        switches: &["triggersEnabled"],
    },
    Starter {
        section: "workflows",
        list: "workflows",
        switches: &["triggersEnabled"],
    },
    Starter {
        section: "tunnels",
        list: "tunnels",
        switches: &["autoStart", "startWithConnection"],
    },
    Starter {
        section: "embeddedServers",
        list: "servers",
        switches: &["autoStart"],
    },
];

/// The sections an entry's behaviour depends on beside its own.
const USED: &[&str] = &["connections", "settings", "macros"];

/// What a schedule's run history and confirmation are: this machine's, not the
/// backup's.
const SCHEDULE_STATE: &[&str] = &[
    "confirmedAt",
    "enabledAt",
    "lastRunAt",
    "lastResult",
    "history",
];

/// The documents of one side: this machine as it is, or as the restore leaves it.
#[derive(Default, Clone)]
struct Side(HashMap<&'static str, Value>);

impl Side {
    fn doc(&self, section: &str) -> &Value {
        self.0.get(section).unwrap_or(&Value::Null)
    }

    fn items(&self, section: &str, list: &str) -> &[Value] {
        self.doc(section)[list]
            .as_array()
            .map_or(&[], Vec::as_slice)
    }

    fn item(&self, section: &str, list: &str, id: &str) -> Option<&Value> {
        self.items(section, list).iter().find(|i| i["id"] == id)
    }

    /// The saved connections and agents, by id.
    fn connections(&self) -> HashMap<String, Value> {
        let items = sections::spec("connections")
            .and_then(|spec| sections::keyed_items(spec, self.doc("connections")).ok())
            .unwrap_or_default();
        items
            .into_iter()
            .filter_map(|(key, value)| {
                let id = key
                    .strip_prefix("connection:")
                    .or_else(|| key.strip_prefix("agent:"))?;
                Some((id.to_string(), value))
            })
            .collect()
    }
}

/// Whether a switch of `item` is on.
fn is_on(item: &Value, switch: &str) -> bool {
    if switch == "triggersEnabled" {
        return has_triggers(item) && item[switch] != json!(false);
    }
    item[switch] == json!(true)
}

/// Whether an automation or workflow has a trigger that can start it.
fn has_triggers(item: &Value) -> bool {
    item["triggers"]
        .as_array()
        .is_some_and(|triggers| triggers.iter().any(|t| t["kind"] != "manual"))
}

/// Compares what entries do on the two sides.
struct Digest<'a> {
    side: &'a Side,
    connections: HashMap<String, Value>,
}

impl<'a> Digest<'a> {
    fn new(side: &'a Side) -> Self {
        Self {
            side,
            connections: side.connections(),
        }
    }

    /// What `item` does and when, with everything it uses.
    fn of(&self, section: &str, item: &Value) -> Value {
        let mut own = item.as_object().cloned().unwrap_or_default();
        for key in ["name", "description", "tags", "createdAt", "updatedAt"] {
            own.remove(key);
        }
        let starter = STARTERS.iter().find(|s| s.section == section);
        for switch in starter.map_or(&[][..], |s| s.switches) {
            own.remove(*switch);
        }
        if section == "schedules" {
            for key in SCHEDULE_STATE {
                own.remove(*key);
            }
        }
        let mut used = Map::new();
        let mut seen = BTreeSet::new();
        self.use_strings(&Value::Object(own.clone()), &mut used, &mut seen);
        json!({ "own": own, "used": used })
    }

    /// Collect what the strings of `value` name: automations, connections, agents and
    /// broadcast groups, and what those name in turn. A string that only looks like
    /// such an id adds something to compare, never takes something away.
    fn use_strings(
        &self,
        value: &Value,
        used: &mut Map<String, Value>,
        seen: &mut BTreeSet<String>,
    ) {
        match value {
            Value::String(id) => {
                if seen.insert(id.clone()) {
                    for (key, found) in self.named(id) {
                        self.use_strings(&found, used, seen);
                        used.insert(key, found);
                    }
                }
            }
            Value::Array(items) => items.iter().for_each(|v| self.use_strings(v, used, seen)),
            Value::Object(map) => map.values().for_each(|v| self.use_strings(v, used, seen)),
            _ => {}
        }
    }

    /// What has this id, without its name and other things that change nothing.
    fn named(&self, id: &str) -> Vec<(String, Value)> {
        let mut found = Vec::new();
        for (section, list) in [
            ("automations", "automations"),
            ("workflows", "workflows"),
            ("macros", "macros"),
        ] {
            for legacy in self.legacy_ids(section, id) {
                if let Some(item) = self.side.item(section, list, &legacy) {
                    found.push((
                        format!("{section}:{legacy}"),
                        json!([item["steps"], item["parameters"]]),
                    ));
                }
            }
        }
        if let Some(connection) = self.connections.get(id) {
            found.push((format!("connection:{id}"), connection["config"].clone()));
        }
        if let Some(group) = self.side.item("settings", "broadcastGroups", id) {
            found.push((format!("group:{id}"), group["connectionIds"].clone()));
        }
        found
    }

    /// The ids an automation has in a section: a converted one may have another id in
    /// the old file, which the next start merges into it.
    fn legacy_ids(&self, section: &str, id: &str) -> Vec<String> {
        let mut ids = vec![id.to_string()];
        if section != "automations" {
            let remaps = self.side.items("automations", "idRemaps");
            ids.extend(
                remaps
                    .iter()
                    .filter(|r| r["newId"] == id)
                    .filter_map(|r| r["oldId"].as_str().map(str::to_string)),
            );
        }
        ids
    }
}

/// Switch off in `after` what `before` does not have on in the same way. Returns
/// what was switched off.
fn switch_off<Tz: TimeZone>(
    before: &Side,
    after: &mut Side,
    now: DateTime<Utc>,
    tz: &Tz,
) -> Vec<RestoredStart> {
    let mut off = Vec::new();
    let mut changes: Vec<(&Starter, usize, Value)> = Vec::new();
    let (was, will) = (Digest::new(before), Digest::new(after));
    for starter in STARTERS {
        for (index, item) in after
            .items(starter.section, starter.list)
            .iter()
            .enumerate()
        {
            let here = item["id"]
                .as_str()
                .and_then(|id| before.item(starter.section, starter.list, id));
            let same = here.is_some_and(|here| {
                was.of(starter.section, here) == will.of(starter.section, item)
            });
            let mut next = item.clone();
            let mut switches = Vec::new();
            for switch in starter.switches {
                if is_on(item, switch) && !(same && here.is_some_and(|h| is_on(h, switch))) {
                    next[*switch] = json!(false);
                    switches.push((*switch).to_string());
                }
            }
            if starter.section == "schedules" {
                keep_schedule_state(&mut next, here.filter(|_| switches.is_empty()));
            }
            if next != *item {
                changes.push((starter, index, next));
            }
            if !switches.is_empty() {
                off.push(RestoredStart {
                    section: starter.section.to_string(),
                    id: text(item, "id"),
                    name: text(item, "name"),
                    starts: describe(starter.section, item, &switches, after),
                    next_run_at: next_run(starter.section, item, now, tz),
                    exists_here: here.is_some(),
                    on_here: here.is_some_and(|h| starter.switches.iter().any(|s| is_on(h, s))),
                    switches,
                });
            }
        }
    }
    for (starter, index, next) in changes {
        if let Some(doc) = after.0.get_mut(starter.section) {
            doc[starter.list][index] = next;
        }
    }
    // A machine that paused its schedules stays paused.
    if before.doc("schedules")["paused"] == json!(true) {
        if let Some(doc) = after.0.get_mut("schedules") {
            doc["paused"] = json!(true);
        }
    }
    hold_workspace_commands(before, after);
    off
}

/// A schedule that stays on keeps when it ran here, so that an older time of the
/// backup does not make it catch up at once; one that is off was confirmed by nobody.
fn keep_schedule_state(next: &mut Value, here: Option<&Value>) {
    let Some(schedule) = next.as_object_mut() else {
        return;
    };
    let Some(here) = here else {
        if schedule.get("enabled") != Some(&json!(true)) {
            schedule.remove("confirmedAt");
            schedule.remove("enabledAt");
        }
        return;
    };
    for key in SCHEDULE_STATE {
        match here.get(*key) {
            Some(value) => schedule.insert((*key).to_string(), value.clone()),
            None => schedule.remove(*key),
        };
    }
}

/// Hold back the commands of every workspace that is not the one here.
fn hold_workspace_commands(before: &Side, after: &mut Side) {
    let Some(list) = after
        .0
        .get_mut("workspaces")
        .and_then(|doc| doc["workspaces"].as_array_mut())
    else {
        return;
    };
    for workspace in list {
        let here = workspace["id"]
            .as_str()
            .and_then(|id| before.item("workspaces", "workspaces", id));
        if here.is_some_and(|here| here["tabGroups"] == workspace["tabGroups"]) {
            continue;
        }
        let groups = workspace["tabGroups"].clone();
        if let Ok(mut groups) = serde_json::from_value::<Vec<WorkspaceTabGroupDef>>(groups) {
            mark_groups_untrusted(&mut groups);
            workspace["tabGroups"] = json!(groups);
        }
    }
}

fn text(item: &Value, key: &str) -> String {
    item[key].as_str().unwrap_or_default().to_string()
}

/// `A`, `A and B`, `A, B and C`.
fn join(names: &[String]) -> String {
    match names.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
        _ => names.concat(),
    }
}

/// What would start an entry, for the user.
fn describe(section: &str, item: &Value, switches: &[String], after: &Side) -> Vec<String> {
    let connections = after.connections();
    let name = |id: &Value| {
        let id = id.as_str().unwrap_or_default();
        connections
            .get(id)
            .map_or_else(|| id.to_string(), |c| text(c, "name"))
    };
    let names = |ids: &Value| {
        let names: Vec<String> = ids.as_array().into_iter().flatten().map(name).collect();
        join(&names)
    };
    match section {
        "schedules" => {
            let rule = serde_json::from_value::<ScheduleRule>(item["rule"].clone());
            let when = rule.map(|r| describe_rule(&r)).unwrap_or_default();
            let on = match item["targets"]["groupId"].as_str() {
                Some(id) => after
                    .item("settings", "broadcastGroups", id)
                    .map_or_else(|| id.to_string(), |g| text(g, "name")),
                None => names(&item["targets"]["connectionIds"]),
            };
            vec![format!("{when} on {on}")]
        }
        "automations" | "workflows" => {
            let triggers = item["triggers"].as_array().into_iter().flatten();
            triggers
                .filter_map(|t| match t["kind"].as_str()? {
                    "manual" => None,
                    "hotkey" => Some(format!("Hotkey {}", text(t, "binding"))),
                    "on-connect" => {
                        Some(format!("When connecting to {}", names(&t["connectionIds"])))
                    }
                    "on-disconnect" => {
                        Some(format!("When {} disconnects", names(&t["connectionIds"])))
                    }
                    "on-output-match" => Some(format!(
                        "When {} prints “{}”",
                        names(&t["connectionIds"]),
                        text(t, "pattern")
                    )),
                    other => Some(format!("Trigger {other}")),
                })
                .collect()
        }
        "tunnels" => switches
            .iter()
            .map(|switch| match switch.as_str() {
                "startWithConnection" => {
                    format!("When connecting to {}", name(&item["sshConnectionId"]))
                }
                _ => "When termiHub starts".to_string(),
            })
            .collect(),
        _ => vec![format!(
            "When termiHub starts: opens port {} on {}",
            item["port"],
            text(item, "bindHost")
        )],
    }
}

fn describe_rule(rule: &ScheduleRule) -> String {
    match rule {
        ScheduleRule::Interval { every_minutes: 1 } => "Every minute".to_string(),
        ScheduleRule::Interval { every_minutes } => format!("Every {every_minutes} minutes"),
        ScheduleRule::Daily { time } => format!("Daily at {time}"),
        ScheduleRule::Weekly { days, time } => {
            let days: Vec<String> = days.iter().map(|d| d.to_chrono().to_string()).collect();
            format!("{} at {time}", days.join(", "))
        }
    }
}

/// When a schedule would run next if it were switched on now.
fn next_run<Tz: TimeZone>(
    section: &str,
    item: &Value,
    now: DateTime<Utc>,
    tz: &Tz,
) -> Option<String> {
    if section != "schedules" {
        return None;
    }
    let rule = serde_json::from_value::<ScheduleRule>(item["rule"].clone()).ok()?;
    next_run_after(&rule, now, now, tz).map(|d| d.to_rfc3339())
}

/// The sections this module reads.
fn all_sections() -> impl Iterator<Item = &'static str> {
    STARTERS
        .iter()
        .map(|s| s.section)
        .chain(USED.iter().copied())
        .chain(["workspaces"])
}

/// This machine as it is. What cannot be read counts as not there, so nothing of it
/// counts as on.
fn here(config_dir: &Path) -> Side {
    let mut side = Side::default();
    for id in all_sections() {
        let Some(spec) = sections::spec(id) else {
            continue;
        };
        if let CurrentDoc::Present(doc) = sections::read_current(spec, config_dir) {
            side.0.insert(id, doc);
        }
    }
    side
}

/// Switch off, in the prepared files of a restore, what would start by itself, and
/// add the files of this machine in which something has to be switched off.
pub fn quieten(
    files: &mut Vec<(String, Zeroizing<String>)>,
    config_dir: &Path,
) -> Result<Vec<RestoredStart>, String> {
    let before = here(config_dir);
    let mut after = before.clone();
    let mut chosen = BTreeSet::new();
    for id in all_sections() {
        let Some(spec) = sections::spec(id) else {
            continue;
        };
        if let Some((_, text)) = files.iter().find(|(name, _)| name == spec.file_name) {
            let doc = serde_json::from_str(text).map_err(|e| e.to_string())?;
            after.0.insert(id, doc);
            chosen.insert(id);
        }
    }
    if chosen.is_empty() {
        return Ok(Vec::new());
    }
    let prepared = after.clone();
    let off = switch_off(&before, &mut after, Utc::now(), &chrono::Local);
    for id in all_sections() {
        if after.doc(id) == prepared.doc(id) {
            continue;
        }
        let Some(spec) = sections::spec(id) else {
            continue;
        };
        let doc = if chosen.contains(id) {
            after.doc(id).clone()
        } else {
            // This machine's file, with only the switches changed: what a backup
            // would leave out of it (bookkeeping) stays.
            let Some(doc) = switched_file(&config_dir.join(spec.file_name), id, &off) else {
                continue;
            };
            doc
        };
        let text = Zeroizing::new(serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?);
        match files.iter_mut().find(|(name, _)| name == spec.file_name) {
            Some((_, existing)) => *existing = text,
            None => files.push((spec.file_name.to_string(), text)),
        }
    }
    Ok(off)
}

/// A file of this machine with the switches in `off` turned off.
fn switched_file(path: &Path, section: &str, off: &[RestoredStart]) -> Option<Value> {
    let mut doc: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let starter = STARTERS.iter().find(|s| s.section == section)?;
    let items = doc[starter.list].as_array_mut()?;
    for entry in off.iter().filter(|o| o.section == section) {
        for item in items.iter_mut().filter(|i| i["id"] == entry.id.as_str()) {
            for switch in &entry.switches {
                item[switch.as_str()] = json!(false);
            }
            if section == "schedules" {
                keep_schedule_state(item, None);
            }
        }
    }
    Some(doc)
}

/// What restoring every section of a backup would leave switched off, for the
/// preview.
pub fn preview(docs: Vec<(&'static str, Value)>, config_dir: &Path) -> Vec<RestoredStart> {
    let before = here(config_dir);
    let mut after = before.clone();
    for (id, doc) in docs {
        if let Some(id) = all_sections().find(|s| *s == id) {
            // What is only here stays in view: a restore can change what it starts.
            let merged = match (STARTERS.iter().find(|s| s.section == id), before.0.get(id)) {
                (Some(starter), Some(here)) => with_missing(doc, here, starter.list),
                _ => doc,
            };
            after.0.insert(id, merged);
        }
    }
    switch_off(&before, &mut after, Utc::now(), &chrono::Local)
}

/// `doc` with the entries of `here` it does not have.
fn with_missing(mut doc: Value, here: &Value, list: &str) -> Value {
    if let (Some(items), Some(mine)) = (doc[list].as_array().cloned(), here[list].as_array()) {
        let known: BTreeSet<&str> = items.iter().filter_map(|i| i["id"].as_str()).collect();
        let missing = mine
            .iter()
            .filter(|i| i["id"].as_str().is_some_and(|id| !known.contains(id)));
        doc[list] = items.iter().chain(missing).cloned().collect();
    }
    doc
}

/// Whether a switch of an entry is still off in `doc`, its section's document.
pub fn still_off(doc: &Value, entry: &RestoredStart) -> bool {
    let Some(starter) = STARTERS.iter().find(|s| s.section == entry.section) else {
        return false;
    };
    let items = doc[starter.list].as_array();
    items
        .into_iter()
        .flatten()
        .filter(|i| i["id"] == entry.id.as_str())
        .any(|i| entry.switches.iter().any(|s| !is_on(i, s)))
}

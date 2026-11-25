//! Which automations may run local programs without asking (#6019).

use std::fs;

use serde_json::json;
use tempfile::TempDir;

use super::*;
use crate::automations::manager::AutomationManager;
use crate::automations::storage::StoreFile;

fn manager(dir: &TempDir) -> AutomationManager {
    AutomationManager::with_storage(StoreFile::in_dir(dir.path())).unwrap()
}

/// An automation with one "Run local process" step.
fn runs(id: &str, program: &str, args: &[&str]) -> Automation {
    automation(
        id,
        json!([{ "kind": "run-local-process", "program": program, "args": args }]),
    )
}

/// An automation that runs `other`.
fn calls_automation(id: &str, other: &str) -> Automation {
    automation(
        id,
        json!([{ "kind": "run-automation", "automationId": other }]),
    )
}

fn automation(id: &str, steps: serde_json::Value) -> Automation {
    serde_json::from_value(json!({ "id": id, "name": format!("Name {id}"), "steps": steps }))
        .unwrap()
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn standing(m: &AutomationManager, chain: &[&str], program: &str, args: &[&str]) -> Standing {
    m.standing(
        &strings(chain),
        program,
        &strings(args),
        Path::new("/bin").join(program).as_path(),
    )
}

fn confirm(m: &AutomationManager, chain: &[&str], program: &str, args: &[&str]) {
    m.confirm_command(
        &strings(chain),
        program,
        &strings(args),
        Path::new("/bin").join(program).as_path(),
    )
    .unwrap();
}

fn asks(m: &AutomationManager, chain: &[&str], program: &str, args: &[&str]) -> bool {
    matches!(
        standing(m, chain, program, args),
        Standing::Unconfirmed { .. }
    )
}

fn import(m: &AutomationManager, a: Automation) -> Automation {
    m.save_from(a, SaveOrigin::Import).unwrap()
}

fn trust_file(dir: &TempDir) -> std::path::PathBuf {
    dir.path().join(AutomationTrust::FILE_NAME)
}

#[test]
fn what_the_user_makes_here_is_their_own_and_an_import_is_not() {
    let dir = TempDir::new().unwrap();
    let m = manager(&dir);
    m.save(runs("mine", "make", &[])).unwrap();
    import(&m, runs("theirs", "make", &[]));
    assert_eq!(standing(&m, &["mine"], "make", &[]), Standing::Own);
    assert_eq!(
        standing(&m, &["theirs"], "make", &[]),
        Standing::Unconfirmed {
            names: vec!["Name theirs".into()]
        }
    );
    // Both survive a restart.
    let m = manager(&dir);
    assert_eq!(standing(&m, &["mine"], "make", &[]), Standing::Own);
    assert!(asks(&m, &["theirs"], "make", &[]));
}

#[test]
fn no_key_of_an_automation_sets_or_clears_it() {
    let dir = TempDir::new().unwrap();
    let m = manager(&dir);
    let forged: Automation = serde_json::from_value(json!({
        "id": "theirs", "name": "T", "own": true, "imported": false, "trusted": true,
        "confirmed": ["x"],
        "steps": [{ "kind": "run-local-process", "program": "make", "args": [] }]
    }))
    .unwrap();
    import(&m, forged.clone());
    assert!(asks(&m, &["theirs"], "make", &[]));
    m.save(forged).unwrap();
    assert!(asks(&m, &["theirs"], "make", &[]));
}

#[test]
fn an_edit_a_rename_and_a_copy_do_not_make_it_ones_own() {
    let dir = TempDir::new().unwrap();
    let m = manager(&dir);
    let mut a = import(&m, runs("theirs", "make", &["a"]));
    a.name = "Renamed".into();
    a.steps = runs("x", "make", &["b"]).steps;
    m.save(a.clone()).unwrap();
    assert!(asks(&m, &["theirs"], "make", &["b"]));
    let mut copy = a.clone();
    copy.id = "copy".into();
    m.save_from(copy, SaveOrigin::CopyOf("theirs")).unwrap();
    assert!(asks(&m, &["copy"], "make", &["b"]));
    // A copy of one's own is one's own; one of nothing is not.
    m.save(runs("mine", "make", &[])).unwrap();
    m.save_from(runs("my-copy", "make", &[]), SaveOrigin::CopyOf("mine"))
        .unwrap();
    assert_eq!(standing(&m, &["my-copy"], "make", &[]), Standing::Own);
    m.save_from(runs("stray", "make", &[]), SaveOrigin::CopyOf("gone"))
        .unwrap();
    assert!(asks(&m, &["stray"], "make", &[]));
}

#[test]
fn a_confirmation_is_for_the_exact_command_of_that_automation() {
    let dir = TempDir::new().unwrap();
    let m = manager(&dir);
    let mut a = import(&m, runs("theirs", "make", &["a b"]));
    import(&m, runs("other", "make", &["a b"]));
    confirm(&m, &["theirs"], "make", &["a b"]);
    assert_eq!(
        standing(&m, &["theirs"], "make", &["a b"]),
        Standing::Confirmed
    );
    assert!(asks(&m, &["other"], "make", &["a b"]));
    // The same name that is another file now.
    assert!(matches!(
        m.standing(
            &strings(&["theirs"]),
            "make",
            &strings(&["a b"]),
            Path::new("/evil/make")
        ),
        Standing::Unconfirmed { .. }
    ));
    // Another argument list, also one that would read the same joined.
    a.steps = runs("x", "make", &["a", "b"]).steps;
    m.save(a.clone()).unwrap();
    assert!(asks(&m, &["theirs"], "make", &["a", "b"]));
    // Back to what was confirmed: no question, also after a restart.
    a.steps = runs("x", "make", &["a b"]).steps;
    m.save(a).unwrap();
    let m = manager(&dir);
    assert_eq!(
        standing(&m, &["theirs"], "make", &["a b"]),
        Standing::Confirmed
    );
}

#[test]
fn a_value_that_changes_the_command_asks_again() {
    let dir = TempDir::new().unwrap();
    let m = manager(&dir);
    import(&m, runs("theirs", "sh", &["-c", "echo ${what}"]));
    confirm(&m, &["theirs"], "sh", &["-c", "echo hello"]);
    assert_eq!(
        standing(&m, &["theirs"], "sh", &["-c", "echo hello"]),
        Standing::Confirmed
    );
    assert!(asks(&m, &["theirs"], "sh", &["-c", "echo hello; rm x"]));
    // One's own takes any value.
    m.save(runs("mine", "sh", &["-c", "echo ${what}"])).unwrap();
    assert_eq!(
        standing(&m, &["mine"], "sh", &["-c", "echo anything"]),
        Standing::Own
    );
}

#[test]
fn every_automation_of_a_chain_has_a_say() {
    let dir = TempDir::new().unwrap();
    let m = manager(&dir);
    m.save(runs("mine", "sh", &["-c", "${cmd}"])).unwrap();
    import(&m, runs("theirs", "make", &[]));
    m.save(calls_automation("my-caller", "theirs")).unwrap();
    import(&m, calls_automation("their-caller", "mine"));
    // One's own that runs an imported one.
    assert_eq!(
        standing(&m, &["my-caller", "theirs"], "make", &[]),
        Standing::Unconfirmed {
            names: vec!["Name theirs".into()]
        }
    );
    // An imported one that runs one's own, with a value of its choice.
    assert_eq!(standing(&m, &["mine"], "sh", &["-c", "ls"]), Standing::Own);
    assert!(asks(&m, &["their-caller", "mine"], "sh", &["-c", "ls"]));
    confirm(&m, &["their-caller", "mine"], "sh", &["-c", "ls"]);
    assert_eq!(
        standing(&m, &["their-caller", "mine"], "sh", &["-c", "ls"]),
        Standing::Confirmed
    );
    // Confirmed for one of two is not confirmed.
    import(&m, calls_automation("outer", "their-caller"));
    assert!(asks(
        &m,
        &["outer", "their-caller", "mine"],
        "sh",
        &["-c", "ls"]
    ));
}

#[test]
fn a_chain_counts_only_when_the_stored_automations_are_one() {
    let dir = TempDir::new().unwrap();
    let m = manager(&dir);
    m.save(runs("mine", "make", &[])).unwrap();
    m.save(calls_automation("caller", "mine")).unwrap();
    import(&m, runs("theirs", "rm", &["-r"]));
    for (chain, program, args) in [
        (vec![], "make", vec![]),
        (vec!["gone"], "make", vec![]),
        // The command of another automation.
        (vec!["mine"], "rm", vec!["-r"]),
        (vec!["mine"], "make", vec!["all"]),
        // Not linked, or the wrong way round.
        (vec!["theirs", "mine"], "make", vec![]),
        (vec!["mine", "caller"], "make", vec![]),
        (vec!["caller"], "make", vec![]),
    ] {
        assert_eq!(
            standing(&m, &chain, program, &args),
            Standing::Unknown,
            "{chain:?} {program}"
        );
        assert!(m
            .confirm_command(
                &strings(&chain),
                program,
                &strings(&args),
                Path::new("/bin/x")
            )
            .is_err());
    }
    assert_eq!(
        standing(&m, &["caller", "mine"], "make", &[]),
        Standing::Own
    );
}

#[test]
fn nested_steps_are_found() {
    let dir = TempDir::new().unwrap();
    let m = manager(&dir);
    let step = json!({ "kind": "run-local-process", "program": "make", "args": [] });
    let condition = json!({ "left": "a", "op": "eq", "right": "a" });
    m.save(automation(
        "deep",
        json!([{ "kind": "loop", "loop": { "kind": "count", "count": 1 }, "body": [
            { "kind": "conditional", "condition": condition, "then": [], "else": [step] }
        ] }]),
    ))
    .unwrap();
    assert_eq!(standing(&m, &["deep"], "make", &[]), Standing::Own);
}

#[test]
fn deleting_and_saving_it_again_does_not_make_it_ones_own() {
    let dir = TempDir::new().unwrap();
    let m = manager(&dir);
    let a = import(&m, runs("theirs", "make", &[]));
    confirm(&m, &["theirs"], "make", &[]);
    m.delete("theirs").unwrap();
    // It was still open in an editor.
    m.save(a).unwrap();
    assert!(asks(&m, &["theirs"], "make", &[]));
    // Also one that a restore brought.
    restore(&dir, &[runs("restored", "make", &[])]);
    let m = manager(&dir);
    let restored = m.get("restored").unwrap();
    m.delete("restored").unwrap();
    m.save(restored).unwrap();
    assert!(asks(&m, &["restored"], "make", &[]));
    // One's own stays one's own.
    let mine = m.save(runs("mine", "make", &[])).unwrap();
    m.delete("mine").unwrap();
    m.save(mine).unwrap();
    assert_eq!(standing(&m, &["mine"], "make", &[]), Standing::Own);
}

#[test]
fn an_import_never_replaces_an_automation() {
    let dir = TempDir::new().unwrap();
    let m = manager(&dir);
    m.save(runs("mine", "make", &[])).unwrap();
    for origin in [SaveOrigin::Import, SaveOrigin::CopyOf("mine")] {
        assert!(m.save_from(runs("mine", "rm", &[]), origin).is_err());
    }
    assert_eq!(standing(&m, &["mine"], "make", &[]), Standing::Own);
}

/// Replace the stored library, as a restore does.
fn restore(dir: &TempDir, automations: &[Automation]) {
    let doc = json!({ "version": "1", "automations": automations });
    fs::write(dir.path().join(AutomationStore::FILE_NAME), doc.to_string()).unwrap();
}

#[test]
fn what_a_restore_brings_back_unchanged_is_ones_own_and_the_rest_asks() {
    let dir = TempDir::new().unwrap();
    let m = manager(&dir);
    let mine = m.save(runs("mine", "make", &["a"])).unwrap();
    let edited = m.save(runs("edited", "make", &["a"])).unwrap();
    let theirs = import(&m, runs("theirs", "make", &["a"]));
    confirm(&m, &["theirs"], "make", &["a"]);

    let mut renamed = mine.clone();
    renamed.name = "Renamed in the backup".into();
    let mut other = edited.clone();
    other.steps = runs("x", "make", &["evil"]).steps;
    restore(&dir, &[renamed, other, theirs, runs("new", "make", &["a"])]);

    let m = manager(&dir);
    assert_eq!(standing(&m, &["mine"], "make", &["a"]), Standing::Own);
    assert!(asks(&m, &["edited"], "make", &["evil"]));
    assert!(asks(&m, &["new"], "make", &["a"]));
    // Still imported, still confirmed on this machine.
    assert_eq!(
        standing(&m, &["theirs"], "make", &["a"]),
        Standing::Confirmed
    );
    // A command that a restore put here is not made one's own by an edit.
    let mut changed = m.get("edited").unwrap();
    changed.name = "x".into();
    m.save(changed).unwrap();
    assert!(asks(&m, &["edited"], "make", &["evil"]));
}

#[test]
fn everything_that_decides_a_program_is_in_the_fingerprint() {
    let base = runs("a", "make", &["x"]);
    let with = |change: fn(&mut serde_json::Value)| {
        let mut value = serde_json::to_value(&base).unwrap();
        change(&mut value);
        fingerprint(&serde_json::from_value(value).unwrap())
    };
    let same = fingerprint(&base);
    type Change = fn(&mut serde_json::Value);
    let harmless: [Change; 5] = [
        |v| v["name"] = json!("other"),
        |v| v["triggers"] = json!([{ "kind": "hotkey", "binding": "F9" }]),
        |v| v["triggersEnabled"] = json!(false),
        |v| v["laterKey"] = json!(1),
        |v| v["steps"][0]["continueOnError"] = json!(true),
    ];
    for change in harmless {
        assert_eq!(with(change), same);
    }
    let decides: [Change; 4] = [
        |v| v["steps"][0]["program"] = json!("rm"),
        |v| v["steps"][0]["args"] = json!(["x", "y"]),
        |v| v["parameters"] = json!([{ "name": "p", "type": "string", "default": "evil" }]),
        |v| {
            v["steps"]
                .as_array_mut()
                .unwrap()
                .push(json!({ "kind": "run-automation", "automationId": "b" }));
        },
    ];
    for change in decides {
        assert_ne!(with(change), same);
    }
}

#[test]
fn the_first_start_takes_the_library_as_it_is() {
    let dir = TempDir::new().unwrap();
    restore(&dir, &[runs("old", "make", &[])]);
    let m = manager(&dir);
    assert_eq!(standing(&m, &["old"], "make", &[]), Standing::Own);
    assert!(trust_file(&dir).exists());
    // Only the first one.
    restore(&dir, &[runs("later", "make", &[])]);
    assert!(asks(&manager(&dir), &["later"], "make", &[]));
}

#[test]
fn a_damaged_file_trusts_nothing_now_and_later() {
    let dir = TempDir::new().unwrap();
    manager(&dir).save(runs("mine", "make", &[])).unwrap();
    fs::write(trust_file(&dir), "{ not json").unwrap();
    let m = manager(&dir);
    assert!(!m.take_recovery_warnings().is_empty());
    assert!(asks(&m, &["mine"], "make", &[]));
    assert!(asks(&manager(&dir), &["mine"], "make", &[]));
}

#[test]
fn a_newer_file_trusts_nothing_and_is_left_alone() {
    let dir = TempDir::new().unwrap();
    manager(&dir).save(runs("mine", "make", &[])).unwrap();
    let newer = json!({ "version": "99", "own": {} }).to_string();
    fs::write(trust_file(&dir), &newer).unwrap();
    let m = manager(&dir);
    assert!(asks(&m, &["mine"], "make", &[]));
    m.save(runs("new", "make", &[])).unwrap();
    assert!(m
        .confirm_command(&strings(&["mine"]), "make", &[], Path::new("/bin/make"))
        .is_err());
    assert!(asks(&m, &["mine"], "make", &[]), "not remembered either");
    assert_eq!(fs::read_to_string(trust_file(&dir)).unwrap(), newer);
}

#[test]
fn a_restore_prepared_by_an_older_build_is_not_taken_for_ones_own() {
    let dir = TempDir::new().unwrap();
    restore(&dir, &[runs("mine", "make", &[])]);
    adopt_before_restore(dir.path());
    assert!(!trust_file(&dir).exists(), "nothing is pending");
    fs::create_dir(dir.path().join(PENDING_DIR)).unwrap();
    adopt_before_restore(dir.path());
    restore(&dir, &[runs("mine", "make", &[]), runs("new", "make", &[])]);
    let m = manager(&dir);
    assert_eq!(standing(&m, &["mine"], "make", &[]), Standing::Own);
    assert!(asks(&m, &["new"], "make", &[]));
}

#[test]
fn a_template_becomes_only_what_the_window_can_make_of_it() {
    for (template, text) in [
        ("make", "make"),
        ("${x}", "anything"),
        ("${x}", ""),
        ("a${x}b${y}c", "a-1-b-2-c"),
        ("a${x}b", "ab"),
        ("$${x}", "${x}"),
        ("$${x}", "$${x}"),
        ("${x}", "${x}"),
        ("a${", "a${"),
        ("${x}${y}", "both"),
    ] {
        assert!(can_become(template, text), "{template} {text}");
    }
    for (template, text) in [
        ("make", "make "),
        ("a${x}b", "a"),
        ("a${x}b", "xab"),
        ("a${x}b", "abx"),
        ("aa${x}aa", "aaa"),
        ("$${x}", "value"),
        ("a${x}b${y}c", "acb"),
    ] {
        assert!(!can_become(template, text), "{template} {text}");
    }
}

#[test]
fn a_confirmation_can_be_seen_and_taken_back() {
    let dir = TempDir::new().unwrap();
    let m = manager(&dir);
    import(&m, runs("a", "make", &["${x}"]));
    import(&m, runs("b", "make", &["${x}"]));
    for (id, arg) in [("a", "one"), ("a", "two"), ("a", "one"), ("b", "one")] {
        confirm(&m, &[id], "make", &[arg]);
    }
    let listed = |m: &AutomationManager| -> Vec<(String, Vec<String>)> {
        m.confirmed_commands()
            .unwrap()
            .into_iter()
            .map(|c| {
                let args = c.commands.iter().map(|command| match command {
                    ConfirmedCommand::Command { path, args } => {
                        format!("{path} {}", args.join(" "))
                    }
                    ConfirmedCommand::Hash(hash) => hash.clone(),
                });
                (c.name.unwrap_or_default(), args.collect())
            })
            .collect()
    };
    let one = "/bin/make one".to_string();
    let two = "/bin/make two".to_string();
    assert_eq!(
        listed(&m),
        [
            ("Name a".to_string(), vec![one.clone(), two.clone()]),
            ("Name b".to_string(), vec![one.clone()])
        ]
    );
    let key = m.confirmed_commands().unwrap()[0].commands[0].key();
    m.revoke_confirmed(Some("a"), Some(&key)).unwrap();
    assert!(asks(&m, &["a"], "make", &["one"]));
    assert_eq!(standing(&m, &["a"], "make", &["two"]), Standing::Confirmed);
    assert_eq!(standing(&m, &["b"], "make", &["one"]), Standing::Confirmed);
    // It stays so, and an automation without any is not listed.
    let m = manager(&dir);
    assert_eq!(listed(&m).len(), 2);
    m.revoke_confirmed(Some("a"), None).unwrap();
    assert_eq!(listed(&m), [("Name b".to_string(), vec![one])]);
    m.revoke_confirmed(None, None).unwrap();
    assert!(listed(&manager(&dir)).is_empty());
    assert!(asks(&m, &["b"], "make", &["one"]));
}

/// What a build before #6057 wrote still counts.
#[test]
fn a_confirmation_kept_as_a_hash_still_counts_and_can_be_taken_back() {
    let dir = TempDir::new().unwrap();
    import(&manager(&dir), runs("a", "make", &[]));
    let hash = command_hash(Path::new("/bin/make"), &[]);
    let old = json!({ "version": "1", "own": {}, "confirmed": { "a": [hash] } });
    fs::write(trust_file(&dir), old.to_string()).unwrap();
    let m = manager(&dir);
    assert_eq!(standing(&m, &["a"], "make", &[]), Standing::Confirmed);
    confirm(&m, &["a"], "make", &[]);
    assert_eq!(m.confirmed_commands().unwrap()[0].commands.len(), 1);
    m.revoke_confirmed(Some("a"), Some(&hash)).unwrap();
    assert!(m.confirmed_commands().unwrap().is_empty());
    assert!(asks(&m, &["a"], "make", &[]));
}

#[test]
fn a_confirmation_that_cannot_be_taken_back_stays() {
    let dir = TempDir::new().unwrap();
    let m = manager(&dir);
    import(&m, runs("a", "make", &[]));
    confirm(&m, &["a"], "make", &[]);
    fs::write(trust_file(&dir), json!({ "version": "99" }).to_string()).unwrap();
    assert!(m.revoke_confirmed(None, None).is_err());
    assert_eq!(standing(&m, &["a"], "make", &[]), Standing::Confirmed);
}

/// The system tests compute the same key (`confirmed_keys`).
#[test]
fn the_key_of_a_command_is_stable() {
    assert_eq!(
        command_hash(Path::new("/bin/make"), &["ä b".to_string()]),
        "7b8428be9b6a25de82332d1d5a207a70f354f723b285036c7116ee0eca811ab0"
    );
}

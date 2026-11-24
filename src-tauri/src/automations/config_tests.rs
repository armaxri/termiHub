//! Serialization tests for the `Automation` model (#5818, slice 1).

use serde_json::{json, Value};

use super::config::{
    Automation, AutomationStep, AutomationTrigger, TypeKeysChunk, TypingSpeed,
    DEFAULT_FIXED_DELAY_MS,
};

fn round_trip(value: Value) -> Value {
    let step: AutomationStep = serde_json::from_value(value).unwrap();
    serde_json::to_value(&step).unwrap()
}

#[test]
fn type_keys_step_round_trips_with_every_field() {
    let raw = json!({
        "kind": "type-keys",
        "chunks": [{ "data": "ls\r", "delayMs": 120 }, { "data": "\u{1b}", "delayMs": 0 }],
        "timing": "fixed",
        "fixedDelayMs": 25,
        "recorded": true,
        "continueOnError": true
    });
    assert_eq!(round_trip(raw.clone()), raw);
}

#[test]
fn type_keys_step_defaults_to_recorded_timing_and_not_recorded() {
    let step: AutomationStep =
        serde_json::from_value(json!({ "kind": "type-keys", "chunks": [{ "data": "x" }] }))
            .unwrap();
    assert_eq!(
        step,
        AutomationStep::TypeKeys {
            error_handling: Default::default(),
            chunks: vec![TypeKeysChunk {
                data: "x".to_string(),
                delay_ms: 0,
            }],
            timing: TypingSpeed::Recorded,
            fixed_delay_ms: None,
            recorded: false,
        }
    );
    // The saved speed is always written; `recorded: false` is omitted.
    let json = serde_json::to_value(&step).unwrap();
    assert_eq!(json["timing"], "recorded");
    assert!(json.get("recorded").is_none());
    assert!(json.get("fixedDelayMs").is_none());
}

#[test]
fn typing_speeds_serialize_lowercase() {
    for (speed, wire) in [
        (TypingSpeed::Recorded, "recorded"),
        (TypingSpeed::Fixed, "fixed"),
        (TypingSpeed::Instant, "instant"),
    ] {
        assert_eq!(serde_json::to_value(speed).unwrap(), wire);
    }
    assert_eq!(DEFAULT_FIXED_DELAY_MS, 40);
}

#[test]
fn run_automation_step_round_trips() {
    let raw = json!({ "kind": "run-automation", "automationId": "a-1", "retry": { "count": 2 } });
    assert_eq!(round_trip(raw.clone()), raw);
}

#[test]
fn legacy_run_macro_reads_as_run_automation() {
    let step: AutomationStep =
        serde_json::from_value(json!({ "kind": "run-macro", "macroId": "macro-1" })).unwrap();
    assert_eq!(
        step,
        AutomationStep::RunAutomation {
            error_handling: Default::default(),
            automation_id: "macro-1".to_string(),
        }
    );
    assert_eq!(
        serde_json::to_value(&step).unwrap(),
        json!({ "kind": "run-automation", "automationId": "macro-1" })
    );
}

#[test]
fn shared_step_kinds_keep_the_workflow_json_shape() {
    for raw in [
        json!({ "kind": "send-command", "command": "ls" }),
        json!({ "kind": "run-script", "script": "a\nb", "perLineDelayMs": 5, "sourcePath": "/x" }),
        json!({ "kind": "wait", "delayMs": 250 }),
        json!({ "kind": "run-local-process", "program": "p", "args": ["a"] }),
        json!({ "kind": "wait-for-output", "pattern": "$ ", "isRegex": false, "timeoutMs": 10 }),
        json!({
            "kind": "conditional",
            "condition": { "left": "a", "op": "eq", "right": "a" },
            "then": [{ "kind": "type-keys", "chunks": [], "timing": "instant" }],
            "else": [{ "kind": "wait", "delayMs": 1 }]
        }),
        json!({
            "kind": "loop",
            "loop": { "kind": "count", "count": 2 },
            "body": [{ "kind": "run-automation", "automationId": "b" }],
            "continueOnError": true
        }),
    ] {
        assert_eq!(round_trip(raw.clone()), raw);
    }
}

#[test]
fn the_manual_trigger_kind_does_not_exist() {
    assert!(serde_json::from_value::<AutomationTrigger>(json!({ "kind": "manual" })).is_err());
}

#[test]
fn every_automatic_trigger_kind_round_trips() {
    let raw = json!([
        { "kind": "on-connect", "connectionIds": ["c1"] },
        { "kind": "hotkey", "binding": "Ctrl+Alt+H" },
        { "kind": "on-disconnect", "connectionIds": ["c1"], "when": "user-close" },
        {
            "kind": "on-output-match", "connectionIds": ["c1"], "pattern": "x",
            "isRegex": true, "cooldownMs": 10, "maxFiresPerSession": 2
        }
    ]);
    let parsed: Vec<AutomationTrigger> = serde_json::from_value(raw.clone()).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), raw);
}

#[test]
fn a_minimal_automation_has_no_triggers_and_is_armed() {
    let a: Automation = serde_json::from_value(json!({ "id": "a", "name": "A" })).unwrap();
    assert!(a.triggers.is_empty(), "no triggers means run it yourself");
    assert!(a.triggers_enabled);
    assert!(a.legacy.is_none());
    let json = serde_json::to_value(&a).unwrap();
    for absent in ["triggersEnabled", "parameters", "legacy", "description"] {
        assert!(json.get(absent).is_none(), "{absent} must be omitted: {json}");
    }
}

#[test]
fn legacy_provenance_round_trips() {
    let raw = json!({
        "id": "a", "name": "A", "tags": [], "steps": [], "triggers": [],
        "triggersEnabled": false, "createdAt": "", "updatedAt": "",
        "legacy": { "from": "macro", "version": 1 }
    });
    let a: Automation = serde_json::from_value(raw.clone()).unwrap();
    assert_eq!(serde_json::to_value(&a).unwrap(), raw);
}

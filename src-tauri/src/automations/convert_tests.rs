//! Golden-file tests for the legacy → automation converters (#5818, slice 1).
//!
//! The inputs under `testdata/` are realistic `macros.json` / `workflows.json`
//! files that exercise every macro and workflow feature the concept
//! inventories. They are loaded through the real versioned-store gate, then
//! converted, and the result is compared with a checked-in `*.expected.json`.
//! Re-bless after an intended change with
//! `UPDATE_GOLDEN=1 cargo test -p termihub --lib automations`.

use std::path::PathBuf;

use serde_json::{json, Value};

use super::config::{Automation, AutomationStep, AutomationTrigger, LegacySource, TypingSpeed};
use super::convert::{convert_library, from_macro, from_workflow, ConvertedLibrary, IdRemap};
use crate::macros::config::{Macro, MacroStore};
use crate::utils::migrate::{load_versioned, LoadOutcome, VersionedStore};
use crate::workflows::config::{Workflow, WorkflowStep, WorkflowStore};

const MACROS_LEGACY: &str = include_str!("testdata/macros_legacy.json");
const WORKFLOWS_LEGACY: &str = include_str!("testdata/workflows_legacy.json");
const MACROS_COLLISION: &str = include_str!("testdata/macros_collision.json");
const WORKFLOWS_COLLISION: &str = include_str!("testdata/workflows_collision.json");

fn load<T: VersionedStore>(raw: &str) -> T {
    match load_versioned::<T>(raw) {
        LoadOutcome::Loaded { data, .. } => data,
        LoadOutcome::Newer(err) => panic!("fixture is newer than this build: {err:?}"),
        LoadOutcome::Corrupt(err) => panic!("fixture does not load: {err}"),
    }
}

fn load_macros(raw: &str) -> Vec<Macro> {
    load::<MacroStore>(raw).macros
}

fn load_workflows(raw: &str) -> Vec<Workflow> {
    load::<WorkflowStore>(raw).workflows
}

/// The comparable JSON form of a conversion result.
fn library_json(library: &ConvertedLibrary) -> Value {
    let remapped: Vec<Value> = library
        .remapped
        .iter()
        .map(|r| json!({ "source": r.source, "oldId": r.old_id, "newId": r.new_id }))
        .collect();
    json!({
        "automations": library.automations,
        "remapped": remapped,
        "unresolvedMacroRefs": library.unresolved_macro_refs,
    })
}

/// Compare `actual` with `testdata/<name>`, or rewrite it under `UPDATE_GOLDEN`.
fn assert_golden(name: &str, actual: &Value) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src/automations/testdata")
        .join(name);
    let pretty = serde_json::to_string_pretty(actual).expect("serialize golden") + "\n";
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::write(&path, pretty).expect("write golden");
        return;
    }
    let expected = std::fs::read_to_string(&path).expect("read golden");
    let expected: Value = serde_json::from_str(&expected).expect("parse golden");
    assert_eq!(
        actual, &expected,
        "{name} is stale; re-bless with UPDATE_GOLDEN=1 if the change is intended.\nactual:\n{pretty}"
    );
}

#[test]
fn legacy_library_converts_to_the_golden_automations() {
    let library = convert_library(
        &load_macros(MACROS_LEGACY),
        &load_workflows(WORKFLOWS_LEGACY),
    );
    assert_golden("legacy.expected.json", &library_json(&library));
}

#[test]
fn colliding_ids_are_reassigned_to_the_golden_ids() {
    let library = convert_library(
        &load_macros(MACROS_COLLISION),
        &load_workflows(WORKFLOWS_COLLISION),
    );
    assert_golden("collision.expected.json", &library_json(&library));
}

#[test]
fn golden_output_reads_back_as_automations() {
    // The converted JSON is valid `automations.json` content: it parses into
    // the model and re-serializes to the same value.
    for raw in [
        include_str!("testdata/legacy.expected.json"),
        include_str!("testdata/collision.expected.json"),
    ] {
        let value: Value = serde_json::from_str(raw).unwrap();
        let parsed: Vec<Automation> = serde_json::from_value(value["automations"].clone()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), value["automations"]);
    }
}

#[test]
fn macro_chunks_are_byte_identical() {
    for source in load_macros(MACROS_LEGACY) {
        let converted = from_macro(&source);
        let chunks: Vec<(String, u64)> = converted
            .steps
            .iter()
            .flat_map(|step| match step {
                AutomationStep::TypeKeys { chunks, .. } => chunks.clone(),
                other => panic!("a macro converts to type-keys only, got {other:?}"),
            })
            .map(|c| (c.data, c.delay_ms))
            .collect();
        let original: Vec<(String, u64)> = source
            .steps
            .iter()
            .map(|s| (s.data.clone(), s.delay_ms))
            .collect();
        assert_eq!(chunks, original, "macro {}", source.id);
        assert!(converted.triggers.is_empty());
        assert_eq!(converted.id, source.id, "the id is kept");
    }
}

#[test]
fn a_macro_is_one_type_keys_step_typed_as_recorded() {
    let source = &load_macros(MACROS_LEGACY)[1];
    let converted = from_macro(source);
    assert_eq!(converted.steps.len(), 1);
    match &converted.steps[0] {
        AutomationStep::TypeKeys {
            chunks,
            timing,
            fixed_delay_ms,
            recorded,
            ..
        } => {
            assert_eq!(chunks.len(), source.steps.len());
            assert_eq!(*timing, TypingSpeed::Recorded);
            assert_eq!(*fixed_delay_ms, None);
            assert!(*recorded);
        }
        other => panic!("expected type-keys, got {other:?}"),
    }
    assert_eq!(converted.legacy.unwrap().from, LegacySource::Macro);
}

#[test]
fn an_empty_macro_has_no_steps() {
    let source = &load_macros(MACROS_LEGACY)[2];
    assert!(source.steps.is_empty());
    assert!(from_macro(source).steps.is_empty());
}

#[test]
fn manual_triggers_are_dropped_and_others_kept_in_order() {
    let workflows = load_workflows(WORKFLOWS_LEGACY);
    let deploy = from_workflow(&workflows[0]);
    assert_eq!(
        deploy.triggers,
        vec![AutomationTrigger::Hotkey {
            binding: "Ctrl+Alt+D".to_string(),
            extra: Default::default()
        }]
    );
    let manual_only = from_workflow(&workflows[3]);
    assert!(manual_only.triggers.is_empty(), "manual alone means none");
    assert_eq!(from_workflow(&workflows[2]).triggers.len(), 4);
}

#[test]
fn workflow_fields_carry_over() {
    let workflows = load_workflows(WORKFLOWS_LEGACY);
    let deploy = from_workflow(&workflows[0]);
    assert_eq!(deploy.parameters, workflows[0].parameters);
    assert_eq!(deploy.description, workflows[0].description);
    assert_eq!(deploy.updated_at, workflows[0].updated_at);
    assert!(
        !from_workflow(&workflows[1]).triggers_enabled,
        "disarmed stays disarmed"
    );
    let legacy = deploy.legacy.unwrap();
    assert_eq!(legacy.from, LegacySource::Workflow);
    assert_eq!(legacy.version, WorkflowStore::CURRENT_VERSION);
}

#[test]
fn run_macro_becomes_run_automation_recursively() {
    fn count_run_macro(steps: &[WorkflowStep]) -> usize {
        steps
            .iter()
            .map(|s| match s {
                WorkflowStep::RunMacro { .. } => 1,
                WorkflowStep::Conditional {
                    then, otherwise, ..
                } => count_run_macro(then) + count_run_macro(otherwise),
                WorkflowStep::Loop { body, .. } => count_run_macro(body),
                _ => 0,
            })
            .sum()
    }
    fn run_automation_ids(steps: &[AutomationStep], out: &mut Vec<String>) {
        for s in steps {
            match s {
                AutomationStep::RunAutomation { automation_id, .. } => {
                    out.push(automation_id.clone())
                }
                AutomationStep::Conditional {
                    then, otherwise, ..
                } => {
                    run_automation_ids(then, out);
                    run_automation_ids(otherwise, out);
                }
                AutomationStep::Loop { body, .. } => run_automation_ids(body, out),
                _ => {}
            }
        }
    }
    let source = &load_workflows(WORKFLOWS_LEGACY)[0];
    let mut ids = Vec::new();
    run_automation_ids(&from_workflow(source).steps, &mut ids);
    assert_eq!(count_run_macro(&source.steps), 3);
    assert_eq!(
        ids,
        vec![
            "macro-01JDREC0000000000000000001",
            "macro-01JDREC0000000000000000002",
            "macro-01JDREC0000000000000000001",
        ]
    );
}

#[test]
fn distinct_ids_are_never_changed() {
    let library = convert_library(
        &load_macros(MACROS_LEGACY),
        &load_workflows(WORKFLOWS_LEGACY),
    );
    assert!(library.remapped.is_empty());
    // A dangling `run-macro` that matches no automation stays as it is.
    assert!(library.unresolved_macro_refs.is_empty());
    assert_eq!(library.automations.len(), 7);
}

#[test]
fn collisions_keep_the_workflow_and_reid_the_macro() {
    let library = convert_library(
        &load_macros(MACROS_COLLISION),
        &load_workflows(WORKFLOWS_COLLISION),
    );
    let remap = |source, old: &str, new: &str| IdRemap {
        source,
        old_id: old.to_string(),
        new_id: new.to_string(),
    };
    assert_eq!(
        library.remapped,
        vec![
            remap(LegacySource::Workflow, "wf-twice", "automation-wf-twice"),
            // `automation-shared` is an input id, so the next free one is used.
            remap(LegacySource::Macro, "shared", "automation-shared-2"),
            remap(LegacySource::Macro, "dup", "automation-dup"),
        ]
    );
    let ids: Vec<&str> = library.automations.iter().map(|a| a.id.as_str()).collect();
    let unique: std::collections::HashSet<&str> = ids.iter().copied().collect();
    assert_eq!(ids.len(), unique.len(), "ids are unique: {ids:?}");
    assert_eq!(library.unresolved_macro_refs, vec!["wf-other", "wf-twice"]);
}

#[test]
fn conversion_is_deterministic() {
    let macros = load_macros(MACROS_COLLISION);
    let workflows = load_workflows(WORKFLOWS_COLLISION);
    assert_eq!(
        convert_library(&macros, &workflows),
        convert_library(&macros, &workflows)
    );
}

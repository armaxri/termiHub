//! Pure converters from the legacy macro and workflow models to
//! [`Automation`] (#5818, slice 1).
//!
//! Nothing here touches the disk, the clock or a random source: the same
//! input always yields the same output, so the boot migration (slice 2) can
//! re-run a conversion and compare results.
//!
//! - A macro becomes an automation with one `type-keys` step that holds the
//!   macro's steps byte for byte, typed at the recorded speed, with no
//!   triggers.
//! - A workflow keeps every field. `manual` triggers are dropped (they never
//!   had an effect) and `run-macro` steps become `run-automation` steps,
//!   recursively inside conditionals and loops.
//! - Ids are kept. When two legacy entries share an id, the workflow keeps
//!   it and the macro gets a deterministic new id (see [`convert_library`]);
//!   every `run-macro` reference to that macro is rewritten in the same pass.

use std::collections::{HashMap, HashSet};

use super::config::{
    Automation, AutomationLegacy, AutomationStep, AutomationTrigger, LegacySource,
    TypeKeysChunk, TypingSpeed,
};
use crate::macros::config::{Macro, MacroStore};
use crate::utils::migrate::VersionedStore;
use crate::workflows::config::{Workflow, WorkflowStep, WorkflowStore, WorkflowTrigger};

/// Prefix of a re-assigned id: `automation-<old id>`, then `-2`, `-3`, ….
pub const REID_PREFIX: &str = "automation-";

/// Prefix for a `run-macro` reference to a macro that does not exist, when
/// keeping the id would make the step run a converted workflow instead.
pub const MISSING_MACRO_PREFIX: &str = "missing-macro-";

/// One id that the library conversion changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdRemap {
    /// The legacy store the entry came from.
    pub source: LegacySource,
    /// The id in the legacy store.
    pub old_id: String,
    /// The id the converted automation carries.
    pub new_id: String,
}

/// The result of converting both legacy libraries at once.
#[derive(Debug, Clone, PartialEq)]
pub struct ConvertedLibrary {
    /// Converted macros (in input order), then converted workflows.
    pub automations: Vec<Automation>,
    /// Every entry whose id had to change, in the order it was assigned.
    /// Schedules and run history that point at `old_id` must follow it.
    pub remapped: Vec<IdRemap>,
    /// Macro ids that `run-macro` steps named but no macro carried, and that
    /// were rewritten so they keep failing instead of running a workflow.
    pub unresolved_macro_refs: Vec<String>,
}

/// Convert one macro into an automation with a single `type-keys` step.
///
/// An empty macro becomes an automation with no steps.
pub fn from_macro(source: &Macro) -> Automation {
    let steps = if source.steps.is_empty() {
        Vec::new()
    } else {
        vec![AutomationStep::TypeKeys {
            error_handling: Default::default(),
            chunks: source
                .steps
                .iter()
                .map(|step| TypeKeysChunk {
                    data: step.data.clone(),
                    delay_ms: step.delay_ms,
                })
                .collect(),
            timing: TypingSpeed::Recorded,
            fixed_delay_ms: None,
            recorded: true,
        }]
    };
    Automation {
        id: source.id.clone(),
        name: source.name.clone(),
        description: source.description.clone(),
        tags: source.tags.clone(),
        steps,
        triggers: Vec::new(),
        parameters: Vec::new(),
        triggers_enabled: true,
        created_at: source.created_at.clone(),
        updated_at: source.updated_at.clone(),
        legacy: Some(AutomationLegacy {
            from: LegacySource::Macro,
            version: MacroStore::CURRENT_VERSION,
        }),
    }
}

/// Convert one workflow into an automation, dropping `manual` triggers and
/// turning `run-macro` steps into `run-automation` steps.
pub fn from_workflow(source: &Workflow) -> Automation {
    Automation {
        id: source.id.clone(),
        name: source.name.clone(),
        description: source.description.clone(),
        tags: source.tags.clone(),
        steps: source.steps.iter().map(convert_step).collect(),
        triggers: source.triggers.iter().filter_map(convert_trigger).collect(),
        parameters: source.parameters.clone(),
        triggers_enabled: source.triggers_enabled,
        created_at: source.created_at.clone(),
        updated_at: source.updated_at.clone(),
        legacy: Some(AutomationLegacy {
            from: LegacySource::Workflow,
            version: WorkflowStore::CURRENT_VERSION,
        }),
    }
}

/// Convert one workflow trigger; `manual` has no automation equivalent.
pub fn convert_trigger(trigger: &WorkflowTrigger) -> Option<AutomationTrigger> {
    Some(match trigger.clone() {
        WorkflowTrigger::Manual => return None,
        WorkflowTrigger::OnConnect { connection_ids } => {
            AutomationTrigger::OnConnect { connection_ids }
        }
        WorkflowTrigger::Hotkey { binding } => AutomationTrigger::Hotkey { binding },
        WorkflowTrigger::OnDisconnect {
            connection_ids,
            when,
        } => AutomationTrigger::OnDisconnect {
            connection_ids,
            when,
        },
        WorkflowTrigger::OnOutputMatch {
            connection_ids,
            pattern,
            is_regex,
            cooldown_ms,
            max_fires_per_session,
        } => AutomationTrigger::OnOutputMatch {
            connection_ids,
            pattern,
            is_regex,
            cooldown_ms,
            max_fires_per_session,
        },
    })
}

/// Convert one workflow step (recursively for conditionals and loops).
pub fn convert_step(step: &WorkflowStep) -> AutomationStep {
    match step.clone() {
        WorkflowStep::SendCommand {
            error_handling,
            command,
        } => AutomationStep::SendCommand {
            error_handling,
            command,
        },
        WorkflowStep::RunScript {
            error_handling,
            script,
            per_line_delay_ms,
            source_path,
        } => AutomationStep::RunScript {
            error_handling,
            script,
            per_line_delay_ms,
            source_path,
        },
        WorkflowStep::RunMacro {
            error_handling,
            macro_id,
        } => AutomationStep::RunAutomation {
            error_handling,
            automation_id: macro_id,
        },
        WorkflowStep::Wait {
            error_handling,
            delay_ms,
        } => AutomationStep::Wait {
            error_handling,
            delay_ms,
        },
        WorkflowStep::RunLocalProcess {
            error_handling,
            program,
            args,
        } => AutomationStep::RunLocalProcess {
            error_handling,
            program,
            args,
        },
        WorkflowStep::Conditional {
            error_handling,
            condition,
            then,
            otherwise,
        } => AutomationStep::Conditional {
            error_handling,
            condition,
            then: then.iter().map(convert_step).collect(),
            otherwise: otherwise.iter().map(convert_step).collect(),
        },
        WorkflowStep::Loop {
            error_handling,
            mode,
            body,
        } => AutomationStep::Loop {
            error_handling,
            mode,
            body: body.iter().map(convert_step).collect(),
        },
        WorkflowStep::WaitForOutput {
            error_handling,
            pattern,
            is_regex,
            timeout_ms,
        } => AutomationStep::WaitForOutput {
            error_handling,
            pattern,
            is_regex,
            timeout_ms,
        },
    }
}

/// Convert both legacy libraries into one automation list with unique ids.
///
/// Id rules, all deterministic:
/// 1. Workflows claim their ids first, then macros, each in input order. The
///    first entry with an id keeps it.
/// 2. A later entry with a taken id gets `automation-<old id>`, or
///    `automation-<old id>-2`, `-3`, … when that is taken too. A new id never
///    equals any id in either input, so re-iding one entry cannot push
///    another one off its id.
/// 3. `run-automation` steps (from `run-macro`) that name a re-ided macro are
///    rewritten to its new id. A step that names no macro at all but would
///    now resolve to a converted workflow is pointed at
///    `missing-macro-<id>`, so it keeps failing as it does today.
pub fn convert_library(macros: &[Macro], workflows: &[Workflow]) -> ConvertedLibrary {
    let original: HashSet<&str> = macros
        .iter()
        .map(|m| m.id.as_str())
        .chain(workflows.iter().map(|w| w.id.as_str()))
        .collect();
    let mut ids = IdAllocator {
        original: &original,
        assigned: HashSet::new(),
    };
    let mut remapped = Vec::new();

    let mut converted_workflows: Vec<Automation> = workflows.iter().map(from_workflow).collect();
    for automation in &mut converted_workflows {
        if let Some(new_id) = ids.claim(&automation.id) {
            remapped.push(IdRemap {
                source: LegacySource::Workflow,
                old_id: std::mem::replace(&mut automation.id, new_id.clone()),
                new_id,
            });
        }
    }

    // The id a `run-macro` step resolved to today is the *first* macro with
    // that id, so only that macro's new id is followed.
    let mut macro_targets: HashMap<String, String> = HashMap::new();
    let mut converted_macros: Vec<Automation> = macros.iter().map(from_macro).collect();
    for automation in &mut converted_macros {
        let old_id = automation.id.clone();
        if let Some(new_id) = ids.claim(&old_id) {
            automation.id = new_id.clone();
            remapped.push(IdRemap {
                source: LegacySource::Macro,
                old_id: old_id.clone(),
                new_id,
            });
        }
        macro_targets
            .entry(old_id)
            .or_insert_with(|| automation.id.clone());
    }

    let mut unresolved = Vec::new();
    for automation in &mut converted_workflows {
        rewrite_macro_refs(
            &mut automation.steps,
            &macro_targets,
            &mut ids,
            &mut unresolved,
        );
    }

    let mut automations = converted_macros;
    automations.extend(converted_workflows);
    ConvertedLibrary {
        automations,
        remapped,
        unresolved_macro_refs: unresolved,
    }
}

/// Hands out unique ids for [`convert_library`].
struct IdAllocator<'a> {
    /// Every id present in either legacy input.
    original: &'a HashSet<&'a str>,
    /// Ids already given to a converted automation (or a missing-macro ref).
    assigned: HashSet<String>,
}

impl IdAllocator<'_> {
    /// Claim `id`; returns `Some(new id)` when it was already taken.
    fn claim(&mut self, id: &str) -> Option<String> {
        if self.assigned.insert(id.to_string()) {
            return None;
        }
        let new_id = self.fresh(REID_PREFIX, id);
        self.assigned.insert(new_id.clone());
        Some(new_id)
    }

    /// The first `<prefix><id>[-n]` that is neither an input id nor assigned.
    fn fresh(&self, prefix: &str, id: &str) -> String {
        let base = format!("{prefix}{id}");
        let mut candidate = base.clone();
        let mut n = 2u32;
        while self.original.contains(candidate.as_str()) || self.assigned.contains(&candidate) {
            candidate = format!("{base}-{n}");
            n += 1;
        }
        candidate
    }
}

/// Re-point `run-automation` steps that came from `run-macro` (see rule 3 of
/// [`convert_library`]), recursing into conditionals and loops.
fn rewrite_macro_refs(
    steps: &mut [AutomationStep],
    macro_targets: &HashMap<String, String>,
    ids: &mut IdAllocator<'_>,
    unresolved: &mut Vec<String>,
) {
    for step in steps {
        match step {
            AutomationStep::RunAutomation { automation_id, .. } => {
                if let Some(target) = macro_targets.get(automation_id.as_str()) {
                    automation_id.clone_from(target);
                } else if ids.assigned.contains(automation_id.as_str()) {
                    if !unresolved.contains(automation_id) {
                        unresolved.push(automation_id.clone());
                    }
                    *automation_id = ids.fresh(MISSING_MACRO_PREFIX, automation_id);
                }
            }
            AutomationStep::Conditional {
                then, otherwise, ..
            } => {
                rewrite_macro_refs(then, macro_targets, ids, unresolved);
                rewrite_macro_refs(otherwise, macro_targets, ids, unresolved);
            }
            AutomationStep::Loop { body, .. } => {
                rewrite_macro_refs(body, macro_targets, ids, unresolved);
            }
            _ => {}
        }
    }
}

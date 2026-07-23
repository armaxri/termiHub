use serde::{Deserialize, Serialize};

/// A single, typed step of a workflow.
///
/// Unlike a [`crate::macros::config::MacroStep`] (an opaque recorded input
/// chunk), a workflow step is *authored* and *discriminated*: the `kind` tag
/// selects one of a fixed set of actions. The complete v1 union is defined here
/// up front — only `send-command` is executed by the runner in the foundation
/// (#1852); the remaining variants are typed placeholders that later children of
/// the Workflow Automation epic (#1851) wire up (#1853 run-script/run-macro/wait,
/// #1857 run-local-process) without having to edit this model.
///
/// The tag is `kind` (matching the TS discriminated union) and variant names are
/// kebab-case (`send-command`, `run-script`, …); struct-variant fields are
/// camelCase so the JSON shape matches the TypeScript `Workflow` type exactly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum WorkflowStep {
    /// Send a single authored command line into the active session (with a
    /// trailing newline). The everyday building block — "run `git status`".
    #[serde(rename_all = "camelCase")]
    SendCommand {
        /// The command line to send (a trailing newline is added on execution).
        command: String,
    },

    /// Stream a saved multi-line script's *text* into the session, line by line,
    /// with an optional per-line delay. Executed by #1853.
    #[serde(rename_all = "camelCase")]
    RunScript {
        /// The script body (one command per line).
        script: String,
        /// Optional delay (ms) inserted between each streamed line.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        per_line_delay_ms: Option<u64>,
        /// Optional on-disk path the script body was loaded from.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_path: Option<String>,
    },

    /// Replay an existing stored macro by id, reusing the macro's own timing
    /// mode. Executed by #1853 (dispatches back into macro playback).
    #[serde(rename_all = "camelCase")]
    RunMacro {
        /// The id of the stored macro to replay.
        macro_id: String,
    },

    /// Pause for a fixed number of milliseconds before the next step. Executed
    /// by #1853.
    #[serde(rename_all = "camelCase")]
    Wait {
        /// How long to pause, in milliseconds.
        delay_ms: u64,
    },

    /// Spawn a **local** helper process (not on the remote host). Security-
    /// sensitive; gated behind an explicit opt-in and confirm-on-first-run.
    /// Executed by #1857 — kept in the model now so no later child edits it.
    #[serde(rename_all = "camelCase")]
    RunLocalProcess {
        /// The local program to spawn.
        program: String,
        /// Arguments passed to the program.
        #[serde(default)]
        args: Vec<String>,
    },
}

/// A trigger that launches a workflow. The complete v1 union is defined here up
/// front; dispatch is wired by #1855 (manual palette/hotkey + on-connect).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum WorkflowTrigger {
    /// The user runs it from the palette, the Workflow sidebar, or a button.
    Manual,

    /// Fires when a session opens for one of the named connections.
    #[serde(rename_all = "camelCase")]
    OnConnect {
        /// Connection ids this trigger is bound to.
        #[serde(default)]
        connection_ids: Vec<String>,
    },

    /// Fires when a user-assigned keybinding is pressed while a session is
    /// focused.
    #[serde(rename_all = "camelCase")]
    Hotkey {
        /// The keybinding string (e.g. `Ctrl+Alt+H`).
        binding: String,
    },
}

/// An authored, ordered list of typed steps launched by zero or more triggers.
///
/// Mirrors the shipped [`crate::macros::config::Macro`] shape (id, name,
/// description, tags, timestamps) but replaces the homogeneous `MacroStep[]`
/// with a discriminated [`WorkflowStep`] list and adds a [`WorkflowTrigger`]
/// list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    /// Unique workflow identifier.
    pub id: String,
    /// User-friendly name for this workflow.
    pub name: String,
    /// Optional free-text description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Optional tags for grouping/filtering in the manager UI.
    #[serde(default)]
    pub tags: Vec<String>,
    /// The ordered steps that make up this workflow.
    #[serde(default)]
    pub steps: Vec<WorkflowStep>,
    /// The triggers that can launch this workflow.
    #[serde(default)]
    pub triggers: Vec<WorkflowTrigger>,
    /// RFC 3339 timestamp of when the workflow was first created.
    #[serde(default)]
    pub created_at: String,
    /// RFC 3339 timestamp of the workflow's last update.
    #[serde(default)]
    pub updated_at: String,
}

/// Top-level schema for the workflows JSON file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowStore {
    /// Schema version, for forward-compatible migrations.
    pub version: String,
    /// All stored workflows.
    pub workflows: Vec<Workflow>,
}

impl Default for WorkflowStore {
    fn default() -> Self {
        Self {
            version: "1".to_string(),
            workflows: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workflow_store_default_is_empty() {
        let store = WorkflowStore::default();
        assert_eq!(store.version, "1");
        assert!(store.workflows.is_empty());
    }

    #[test]
    fn send_command_step_serializes_with_kind_tag() {
        let step = WorkflowStep::SendCommand {
            command: "git status".to_string(),
        };
        let json = serde_json::to_string(&step).unwrap();
        assert!(json.contains("\"kind\":\"send-command\""));
        assert!(json.contains("\"command\":\"git status\""));
        let parsed: WorkflowStep = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, step);
    }

    #[test]
    fn run_script_step_uses_camel_case_optional_fields() {
        let step = WorkflowStep::RunScript {
            script: "echo one\necho two".to_string(),
            per_line_delay_ms: Some(50),
            source_path: Some("/tmp/health.sh".to_string()),
        };
        let json = serde_json::to_string(&step).unwrap();
        assert!(json.contains("\"kind\":\"run-script\""));
        assert!(json.contains("\"perLineDelayMs\":50"));
        assert!(json.contains("\"sourcePath\":\"/tmp/health.sh\""));
        let parsed: WorkflowStep = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, step);
    }

    #[test]
    fn run_script_step_omits_absent_optional_fields() {
        let step = WorkflowStep::RunScript {
            script: "echo hi".to_string(),
            per_line_delay_ms: None,
            source_path: None,
        };
        let json = serde_json::to_string(&step).unwrap();
        assert!(!json.contains("perLineDelayMs"));
        assert!(!json.contains("sourcePath"));
        // A file that never wrote the optional fields still parses.
        let parsed: WorkflowStep =
            serde_json::from_str(r#"{"kind":"run-script","script":"echo hi"}"#).unwrap();
        assert_eq!(parsed, step);
    }

    #[test]
    fn all_step_kinds_round_trip() {
        let steps = vec![
            WorkflowStep::SendCommand {
                command: "sudo -v".to_string(),
            },
            WorkflowStep::RunScript {
                script: "a\nb".to_string(),
                per_line_delay_ms: Some(10),
                source_path: None,
            },
            WorkflowStep::RunMacro {
                macro_id: "macro-1".to_string(),
            },
            WorkflowStep::Wait { delay_ms: 500 },
            WorkflowStep::RunLocalProcess {
                program: "notify-send".to_string(),
                args: vec!["done".to_string()],
            },
        ];
        let json = serde_json::to_string(&steps).unwrap();
        assert!(json.contains("\"kind\":\"run-macro\""));
        assert!(json.contains("\"macroId\":\"macro-1\""));
        assert!(json.contains("\"kind\":\"wait\""));
        assert!(json.contains("\"delayMs\":500"));
        assert!(json.contains("\"kind\":\"run-local-process\""));
        let parsed: Vec<WorkflowStep> = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, steps);
    }

    #[test]
    fn all_trigger_kinds_round_trip() {
        let triggers = vec![
            WorkflowTrigger::Manual,
            WorkflowTrigger::OnConnect {
                connection_ids: vec!["prod-web-1".to_string(), "prod-web-2".to_string()],
            },
            WorkflowTrigger::Hotkey {
                binding: "Ctrl+Alt+H".to_string(),
            },
        ];
        let json = serde_json::to_string(&triggers).unwrap();
        assert!(json.contains("\"kind\":\"manual\""));
        assert!(json.contains("\"kind\":\"on-connect\""));
        assert!(json.contains("\"connectionIds\""));
        assert!(json.contains("\"kind\":\"hotkey\""));
        let parsed: Vec<WorkflowTrigger> = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, triggers);
    }

    #[test]
    fn workflow_serializes_with_camel_case_keys() {
        let wf = Workflow {
            id: "wf-1".to_string(),
            name: "Prod login".to_string(),
            description: Some("Login and health check".to_string()),
            tags: vec!["ops".to_string()],
            steps: vec![WorkflowStep::SendCommand {
                command: "sudo -v".to_string(),
            }],
            triggers: vec![WorkflowTrigger::Manual],
            created_at: "2026-07-24T00:00:00Z".to_string(),
            updated_at: "2026-07-24T00:00:00Z".to_string(),
        };
        let json = serde_json::to_string(&wf).unwrap();
        assert!(json.contains("\"createdAt\""));
        assert!(json.contains("\"updatedAt\""));
        let parsed: Workflow = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, wf);
    }

    #[test]
    fn workflow_defaults_absent_collections() {
        // A minimal workflow (only id + name) parses with empty collections.
        let wf: Workflow = serde_json::from_str(r#"{"id":"wf-1","name":"Bare"}"#).unwrap();
        assert!(wf.steps.is_empty());
        assert!(wf.triggers.is_empty());
        assert!(wf.tags.is_empty());
        assert_eq!(wf.description, None);
    }
}

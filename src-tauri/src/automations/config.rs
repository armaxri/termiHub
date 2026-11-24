//! The persisted `Automation` model (#5818, slice 1).
//!
//! An automation is the workflow shape with two changes: a `type-keys` step
//! that carries recorded or hand-written terminal input byte for byte (what a
//! macro was), and a `run-automation` step that replaces `run-macro`. Triggers
//! are optional: an empty list means "run it yourself", so the old no-op
//! `manual` trigger kind does not exist here.
//!
//! The leaf types that did not change (error handling, conditions, loop modes,
//! parameters, disconnect causes) are reused from the workflow model so the
//! JSON stays identical; they move here when the legacy modules shrink to
//! readers (slice 12).

use serde::{Deserialize, Serialize};

use crate::workflows::config::{
    WorkflowCondition, WorkflowDisconnectCause, WorkflowLoopMode, WorkflowParameter,
    WorkflowStepErrorHandling,
};

/// The fixed per-chunk delay (ms) used by [`TypingSpeed::Fixed`] when the step
/// does not set `fixedDelayMs`. Matches the macro player's `fixed` mode.
pub const DEFAULT_FIXED_DELAY_MS: u64 = 40;

/// One chunk of terminal input inside a `type-keys` step.
///
/// Byte-identical to a legacy macro step: `data` is an opaque string (UTF-8
/// text or base64-encoded bytes) and no newline is ever added to it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct TypeKeysChunk {
    /// The input for this chunk (UTF-8 text or base64-encoded bytes).
    pub data: String,
    /// Delay in milliseconds before this chunk is typed, as recorded.
    #[serde(default)]
    #[cfg_attr(test, ts(type = "number"))]
    pub delay_ms: u64,
}

/// How fast a `type-keys` step types its chunks. Saved on the step, so an
/// automation types the same way from every entry point (maintainer decision
/// 2026-11-23, question 3).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "lowercase")]
pub enum TypingSpeed {
    /// Use each chunk's recorded `delayMs` (clamped by the runner).
    #[default]
    Recorded,
    /// Wait the same `fixedDelayMs` before every chunk.
    Fixed,
    /// Type every chunk without waiting.
    Instant,
}

/// Which legacy store an automation was converted from.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "lowercase")]
pub enum LegacySource {
    /// Converted from `macros.json`.
    Macro,
    /// Converted from `workflows.json`.
    Workflow,
}

/// Provenance of a converted automation, used by the reconcile pass and by
/// export. Absent on automations created after the merge.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct AutomationLegacy {
    /// The legacy store the automation came from.
    pub from: LegacySource,
    /// The schema version of that store at conversion time.
    pub version: u32,
}

/// A single, typed step of an automation. Every workflow step kind carries
/// over unchanged; `type-keys` is new and `run-automation` replaces
/// `run-macro` (which is still accepted on read).
///
/// Tagged by `kind` (kebab-case variants, camelCase fields) so the JSON shape
/// of the shared kinds is identical to the workflow step it came from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AutomationStep {
    /// Type terminal input exactly as stored: no newline is added and no
    /// `${param}` substitution happens, so recorded bytes stay exact.
    #[serde(rename_all = "camelCase")]
    TypeKeys {
        /// Per-step error handling: retry / continue-on-error.
        #[serde(flatten)]
        error_handling: WorkflowStepErrorHandling,
        /// The chunks to type, in order.
        #[serde(default)]
        chunks: Vec<TypeKeysChunk>,
        /// How fast to type; absent means [`TypingSpeed::Recorded`].
        #[serde(default)]
        #[cfg_attr(test, ts(as = "Option<TypingSpeed>", optional))]
        timing: TypingSpeed,
        /// The per-chunk delay for [`TypingSpeed::Fixed`]; absent means
        /// [`DEFAULT_FIXED_DELAY_MS`].
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional, type = "number"))]
        fixed_delay_ms: Option<u64>,
        /// `true` when the chunks came from a recording (or a legacy macro).
        #[serde(default, skip_serializing_if = "is_false")]
        #[cfg_attr(test, ts(as = "Option<bool>", optional))]
        recorded: bool,
    },

    /// Send one command line (a trailing newline is added on execution).
    #[serde(rename_all = "camelCase")]
    SendCommand {
        /// Per-step error handling: retry / continue-on-error.
        #[serde(flatten)]
        error_handling: WorkflowStepErrorHandling,
        /// The command line to send.
        command: String,
    },

    /// Stream a multi-line script into the session, line by line.
    #[serde(rename_all = "camelCase")]
    RunScript {
        /// Per-step error handling: retry / continue-on-error.
        #[serde(flatten)]
        error_handling: WorkflowStepErrorHandling,
        /// The script body (one command per line).
        script: String,
        /// Optional delay (ms) between streamed lines.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional, type = "number"))]
        per_line_delay_ms: Option<u64>,
        /// Optional on-disk path the script body was loaded from.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional))]
        source_path: Option<String>,
    },

    /// Run another stored automation by id. A legacy `run-macro {macroId}`
    /// step reads as this variant with the macro id as `automationId`.
    #[serde(rename_all = "camelCase", alias = "run-macro")]
    RunAutomation {
        /// Per-step error handling: retry / continue-on-error.
        #[serde(flatten)]
        error_handling: WorkflowStepErrorHandling,
        /// The id of the automation to run.
        #[serde(alias = "macroId")]
        automation_id: String,
    },

    /// Pause for a fixed number of milliseconds.
    #[serde(rename_all = "camelCase")]
    Wait {
        /// Per-step error handling: retry / continue-on-error.
        #[serde(flatten)]
        error_handling: WorkflowStepErrorHandling,
        /// How long to pause, in milliseconds.
        #[cfg_attr(test, ts(type = "number"))]
        delay_ms: u64,
    },

    /// Spawn a local helper process on the desktop. The only step kind that
    /// stays behind the experimental switch (maintainer decision 2026-11-23).
    #[serde(rename_all = "camelCase")]
    RunLocalProcess {
        /// Per-step error handling: retry / continue-on-error.
        #[serde(flatten)]
        error_handling: WorkflowStepErrorHandling,
        /// The local program to spawn.
        program: String,
        /// Arguments passed to the program.
        #[serde(default)]
        args: Vec<String>,
    },

    /// Branch on a structured condition.
    #[serde(rename_all = "camelCase")]
    Conditional {
        /// Per-step error handling: retry / continue-on-error.
        #[serde(flatten)]
        error_handling: WorkflowStepErrorHandling,
        /// The comparison that selects the branch.
        condition: WorkflowCondition,
        /// Steps run when the condition holds.
        #[serde(default)]
        then: Vec<AutomationStep>,
        /// Steps run when the condition is false; omitted when empty.
        #[serde(rename = "else", default, skip_serializing_if = "Vec::is_empty")]
        #[cfg_attr(test, ts(as = "Option<Vec<AutomationStep>>", optional))]
        otherwise: Vec<AutomationStep>,
    },

    /// Repeat a body a fixed number of times or while a condition holds.
    #[serde(rename_all = "camelCase")]
    Loop {
        /// Per-step error handling: retry / continue-on-error.
        #[serde(flatten)]
        error_handling: WorkflowStepErrorHandling,
        /// How the loop is bounded.
        #[serde(rename = "loop")]
        mode: WorkflowLoopMode,
        /// Steps run each iteration.
        #[serde(default)]
        body: Vec<AutomationStep>,
    },

    /// Pause until the session's output matches `pattern` or the timeout ends.
    #[serde(rename_all = "camelCase")]
    WaitForOutput {
        /// Per-step error handling: retry / continue-on-error.
        #[serde(flatten)]
        error_handling: WorkflowStepErrorHandling,
        /// The pattern matched against the terminal output.
        pattern: String,
        /// When `true`, `pattern` is a regular expression.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional))]
        is_regex: Option<bool>,
        /// Max time (ms) to wait; absent means the runner's default.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional, type = "number"))]
        timeout_ms: Option<u64>,
    },
}

/// An automatic trigger. There is no `manual` kind: every automation can be
/// run by hand, so an empty trigger list means "only when I run it".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AutomationTrigger {
    /// Fires when a session opens for one of the named connections.
    #[serde(rename_all = "camelCase")]
    OnConnect {
        /// Connection ids this trigger is bound to.
        #[serde(default)]
        connection_ids: Vec<String>,
    },

    /// Fires when a keybinding is pressed while a session is focused.
    #[serde(rename_all = "camelCase")]
    Hotkey {
        /// The keybinding string (e.g. `Ctrl+Alt+H`).
        binding: String,
    },

    /// Fires once when a session for one of the named connections ends.
    #[serde(rename_all = "camelCase")]
    OnDisconnect {
        /// Connection ids this trigger is bound to.
        #[serde(default)]
        connection_ids: Vec<String>,
        /// Which session endings fire the trigger; absent means drops only.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional))]
        when: Option<WorkflowDisconnectCause>,
    },

    /// Fires when a session for one of the named connections prints output
    /// matching `pattern`.
    #[serde(rename_all = "camelCase")]
    OnOutputMatch {
        /// Connection ids this trigger is bound to.
        #[serde(default)]
        connection_ids: Vec<String>,
        /// A literal substring, or a regular expression when `is_regex`.
        pattern: String,
        /// When `true`, `pattern` is a regular expression.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional))]
        is_regex: Option<bool>,
        /// Minimum time (ms) between two fires in one session.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional, type = "number"))]
        cooldown_ms: Option<u64>,
        /// Maximum number of fires per session.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional))]
        max_fires_per_session: Option<u32>,
    },
}

/// A named, stored automation: an ordered list of typed steps, optionally
/// launched by automatic triggers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    /// Unique automation identifier (legacy macro and workflow ids are kept).
    pub id: String,
    /// User-friendly name.
    pub name: String,
    /// Optional free-text description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub description: Option<String>,
    /// Optional tags for grouping and filtering.
    #[serde(default)]
    pub tags: Vec<String>,
    /// The ordered steps.
    #[serde(default)]
    pub steps: Vec<AutomationStep>,
    /// Automatic triggers; empty means the automation only runs by hand.
    #[serde(default)]
    pub triggers: Vec<AutomationTrigger>,
    /// Declared parameters interpolated via `${name}`; omitted when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(test, ts(as = "Option<Vec<WorkflowParameter>>", optional))]
    pub parameters: Vec<WorkflowParameter>,
    /// Whether the automatic triggers may fire (the Armed switch). Defaults
    /// to `true` and is omitted from JSON while `true`.
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    #[cfg_attr(test, ts(as = "Option<bool>", optional))]
    pub triggers_enabled: bool,
    /// RFC 3339 timestamp of when the automation was first created.
    #[serde(default)]
    pub created_at: String,
    /// RFC 3339 timestamp of the last update.
    #[serde(default)]
    pub updated_at: String,
    /// Where a converted automation came from; absent for new ones.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub legacy: Option<AutomationLegacy>,
}

/// Serde default for [`Automation::triggers_enabled`]: armed.
fn default_true() -> bool {
    true
}

/// Serde skip predicate: omit `true` (the default).
fn is_true(value: &bool) -> bool {
    *value
}

/// Serde skip predicate: omit `false` (the default).
fn is_false(value: &bool) -> bool {
    !*value
}

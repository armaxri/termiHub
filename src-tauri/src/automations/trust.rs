//! Which automations may run local programs without asking first (#6019).
//!
//! An automation the user made here runs what the user allowed. One that came
//! from a file, or that a backup put here, asks once before each local program,
//! with the exact command. This module remembers which is which, in
//! `automation-trust.json`:
//!
//! - **`own`**: the automations made on this machine, each with a fingerprint of
//!   what decides its local programs (its "Run local process" steps, the
//!   automations it runs, its parameters). The fingerprint follows every edit the
//!   user saves here.
//! - **`confirmed`**: for every other automation, the exact commands the user
//!   confirmed: the resolved file and every argument.
//! - **`deleted`**: ids of deleted automations that were not the user's own, so a copy
//!   that is still open in an editor does not come back as the user's own.
//!
//! # Why a file cannot set or clear it
//!
//! The mark is not part of an automation, so no automation file, backup or
//! `automations.json` can hold it. `automation-trust.json` is not a backup section.
//! What is not listed under `own`, or is listed with another fingerprint, is not
//! the user's own: an automation that a restore replaced or an older build changed
//! is asked about, and one that a restore brought back unchanged is not. An
//! unreadable or newer file lists nothing.
//!
//! The first start of a build with this check lists the whole library as `own`:
//! what was imported before cannot be told apart, and existing automations keep
//! working.
//!
//! # Chains
//!
//! A run can reach a program through automations that run each other. Every one of
//! them has a say, because a caller also chooses the parameter values: if any is
//! not the user's own, the exact command must be confirmed for that one. The window
//! reports the chain; it counts only when the stored automations really run each
//! other that way and the last one has a step that can be this command.
//!
//! # What this does not protect against
//!
//! A window that runs foreign code, which can confirm commands itself, and someone
//! who can write to the config directory.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::config::{Automation, AutomationStep};
use super::legacy::sha256_hex;
use super::storage::StoreFile;
use super::store::AutomationStore;
use crate::backup::restore::PENDING_DIR;
use crate::connection::recovery::RecoveryWarning;
use crate::utils::migrate::{load_versioned, LoadOutcome, VersionedStore};

/// `automation-trust.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationTrust {
    /// Schema version.
    pub version: String,
    /// Automation id to the fingerprint it had when the user last saved it here.
    #[serde(default)]
    pub own: BTreeMap<String, String>,
    /// Automation id to the commands confirmed for it.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub confirmed: BTreeMap<String, Vec<ConfirmedCommand>>,
    /// Ids of deleted automations that were not the user's own.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub deleted: BTreeSet<String>,
    /// Keys this build does not know, kept verbatim.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A command the user confirmed for an automation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ConfirmedCommand {
    /// The file and every argument.
    Command {
        /// The resolved file.
        path: String,
        /// Every argument.
        args: Vec<String>,
    },
    /// Its [`command_hash`] only, as an earlier build kept it (#6057).
    Hash(String),
}

impl ConfirmedCommand {
    fn new(path: &Path, args: &[String]) -> Self {
        Self::Command {
            path: path.to_string_lossy().into_owned(),
            args: args.to_vec(),
        }
    }

    /// What names it when it is revoked.
    pub fn key(&self) -> String {
        match self {
            Self::Command { path, args } => command_hash(Path::new(path), args),
            Self::Hash(hash) => hash.clone(),
        }
    }
}

impl AutomationTrust {
    /// The store's file name in the config directory.
    pub const FILE_NAME: &'static str = "automation-trust.json";
}

impl Default for AutomationTrust {
    fn default() -> Self {
        Self {
            version: "1".to_string(),
            own: BTreeMap::new(),
            confirmed: BTreeMap::new(),
            deleted: BTreeSet::new(),
            extra: Map::new(),
        }
    }
}

impl VersionedStore for AutomationTrust {
    const STORE_NAME: &'static str = AutomationTrust::FILE_NAME;
    const CURRENT_VERSION: u32 = 1;
}

/// Where a save came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveOrigin<'a> {
    /// The user made or edited it here.
    User,
    /// It came from a file.
    Import,
    /// A copy of the automation with this id.
    CopyOf(&'a str),
}

/// What is known about the automations behind one command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Standing {
    /// All of them are the user's own.
    Own,
    /// Some are not, and the user confirmed this command for each of those.
    Confirmed,
    /// Some are not, and the user did not.
    Unconfirmed {
        /// Their names, outermost first.
        names: Vec<String>,
    },
    /// The command cannot be traced to stored automations.
    Unknown,
}

/// The hash a command is named by: the file that starts, and every argument.
pub fn command_hash(path: &Path, args: &[String]) -> String {
    sha256_hex(json!([path.to_string_lossy(), args]).to_string().as_bytes())
}

/// The fingerprint of what decides which local programs `automation` starts. Built
/// from named parts rather than from the stored JSON, so that a build that stores
/// something new about an automation does not make every one of them a stranger.
pub fn fingerprint(automation: &Automation) -> String {
    let mut programs = Vec::new();
    let mut calls = Vec::new();
    visit(&automation.steps, &mut |step| match step {
        AutomationStep::RunLocalProcess { program, args, .. } => {
            programs.push(json!([program, args]));
        }
        AutomationStep::RunAutomation { automation_id, .. } => calls.push(automation_id.clone()),
        _ => {}
    });
    let parameters: Vec<Value> = automation
        .parameters
        .iter()
        .map(|p| json!([p.name, p.default]))
        .collect();
    sha256_hex(
        json!({ "programs": programs, "calls": calls, "parameters": parameters })
            .to_string()
            .as_bytes(),
    )
}

/// Every step, nested ones included, in step order.
fn visit<'a>(steps: &'a [AutomationStep], each: &mut impl FnMut(&'a AutomationStep)) {
    for step in steps {
        each(step);
        match step {
            AutomationStep::Conditional {
                then, otherwise, ..
            } => {
                visit(then, each);
                visit(otherwise, each);
            }
            AutomationStep::Loop { body, .. } => visit(body, each),
            _ => {}
        }
    }
}

/// Whether `automation` has a step that runs the automation `id`.
fn calls(automation: &Automation, id: &str) -> bool {
    let mut found = false;
    visit(&automation.steps, &mut |step| {
        if let AutomationStep::RunAutomation { automation_id, .. } = step {
            found |= automation_id == id;
        }
    });
    found
}

/// Whether `automation` has a "Run local process" step that can be this command
/// once its `${name}` references are filled in.
fn starts(automation: &Automation, program: &str, args: &[String]) -> bool {
    let mut found = false;
    visit(&automation.steps, &mut |step| {
        if let AutomationStep::RunLocalProcess {
            program: template,
            args: templates,
            ..
        } = step
        {
            found |= can_become(template, program)
                && templates.len() == args.len()
                && templates.iter().zip(args).all(|(t, a)| can_become(t, a));
        }
    });
    found
}

/// Whether the window's substitution can turn `template` into `text`: a `${name}`
/// becomes anything, `$${` becomes `${`, the rest stays. A template without values
/// for it stays as it is.
fn can_become(template: &str, text: &str) -> bool {
    if template == text {
        return true;
    }
    // The fixed parts, with something unknown between each two of them.
    let mut fixed = vec![String::new()];
    let mut rest = template;
    while let Some(at) = rest.find("${") {
        let escaped = rest[..at].ends_with('$');
        let before = if escaped {
            &rest[..at - 1]
        } else {
            &rest[..at]
        };
        let after = &rest[at + 2..];
        let part = fixed.last_mut();
        let Some(part) = part else { return false };
        part.push_str(before);
        if escaped {
            part.push_str("${");
            rest = after;
        } else if let Some(end) = after.find('}') {
            fixed.push(String::new());
            rest = &after[end + 1..];
        } else {
            part.push_str("${");
            rest = after;
        }
    }
    let Some(part) = fixed.last_mut() else {
        return false;
    };
    part.push_str(rest);
    let [first, middle @ ..] = fixed.as_slice() else {
        return false;
    };
    let Some((last, middle)) = middle.split_last() else {
        return first == text; // No reference at all.
    };
    let Some(mut open) = text.strip_prefix(first.as_str()) else {
        return false;
    };
    for part in middle {
        let Some(at) = open.find(part.as_str()) else {
            return false;
        };
        open = &open[at + part.len()..];
    }
    open.ends_with(last.as_str())
}

/// The trust store in memory, and its file.
pub struct TrustBook {
    trust: AutomationTrust,
    storage: StoreFile<AutomationTrust>,
}

impl TrustBook {
    /// Load the file beside `automations.json`. When there is none, this is the
    /// first start with the check and the whole library is the user's own.
    pub fn load(dir: &Path, library: &AutomationStore) -> (Self, Vec<RecoveryWarning>) {
        let storage = StoreFile::<AutomationTrust>::in_dir(dir);
        let first_start = !storage.path().exists();
        let (trust, warnings) = match storage.load_with_recovery() {
            Ok(result) => (result.data, result.warnings),
            Err(e) => {
                tracing::warn!("{} cannot be read: {e:#}", AutomationTrust::FILE_NAME);
                (AutomationTrust::default(), Vec::new())
            }
        };
        let mut book = Self { trust, storage };
        // A damaged file was reset to an empty one by the load, so the next start
        // is no first start either.
        if first_start {
            book.adopt(library);
            book.save();
        }
        (book, warnings)
    }

    /// List every automation of `library` as the user's own.
    fn adopt(&mut self, library: &AutomationStore) {
        for automation in &library.automations {
            self.trust
                .own
                .insert(automation.id.clone(), fingerprint(automation));
        }
    }

    /// Write the file. A failure only means more questions, so it is no error.
    fn save(&self) -> bool {
        match self.storage.save(&self.trust) {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!("{} cannot be written: {e:#}", AutomationTrust::FILE_NAME);
                false
            }
        }
    }

    /// Whether `automation`, as it is stored, is the user's own.
    pub fn is_own(&self, automation: &Automation) -> bool {
        self.trust.own.get(&automation.id) == Some(&fingerprint(automation))
    }

    /// Note that `saved` replaced `before` in `library` (the state before).
    pub fn saved(
        &mut self,
        saved: &Automation,
        before: Option<&Automation>,
        origin: SaveOrigin,
        library: &AutomationStore,
    ) {
        let own = match (before, origin) {
            // An edit makes nothing one's own.
            (Some(before), _) => self.is_own(before),
            (None, SaveOrigin::User) => !self.trust.deleted.contains(&saved.id),
            (None, SaveOrigin::Import) => false,
            (None, SaveOrigin::CopyOf(source)) => {
                library
                    .automations
                    .iter()
                    .find(|a| a.id == source)
                    .is_some_and(|source| self.is_own(source))
                    && !self.trust.deleted.contains(&saved.id)
            }
        };
        let was = self.trust.clone();
        if own {
            self.trust.own.insert(saved.id.clone(), fingerprint(saved));
        } else {
            self.trust.own.remove(&saved.id);
        }
        if self.trust != was {
            self.save();
        }
    }

    /// Note that `automation` was deleted.
    pub fn deleted(&mut self, automation: &Automation) {
        if !self.is_own(automation) {
            self.trust.deleted.insert(automation.id.clone());
        }
        self.trust.own.remove(&automation.id);
        self.trust.confirmed.remove(&automation.id);
        self.save();
    }

    /// The automations of `chain` that are not the user's own, when the chain can
    /// be traced in `library` to this command; `None` when it cannot.
    fn strangers<'a>(
        &self,
        library: &'a AutomationStore,
        chain: &[String],
        program: &str,
        args: &[String],
    ) -> Option<Vec<&'a Automation>> {
        let automations: Vec<&Automation> = chain
            .iter()
            .map(|id| library.automations.iter().find(|a| a.id == *id))
            .collect::<Option<_>>()?;
        let linked = automations
            .windows(2)
            .all(|pair| calls(pair[0], &pair[1].id));
        if !linked || !starts(automations.last()?, program, args) {
            return None;
        }
        Some(
            automations
                .into_iter()
                .filter(|a| !self.is_own(a))
                .collect(),
        )
    }

    /// What is known about a command: `program` and `args` as the step of the last
    /// automation of `chain` (outermost first) came out, and the file it starts.
    pub fn standing(
        &self,
        library: &AutomationStore,
        chain: &[String],
        program: &str,
        args: &[String],
        path: &Path,
    ) -> Standing {
        let Some(strangers) = self.strangers(library, chain, program, args) else {
            return Standing::Unknown;
        };
        if strangers.is_empty() {
            return Standing::Own;
        }
        let hash = command_hash(path, args);
        let confirmed = |a: &&Automation| self.is_confirmed(&a.id, &hash);
        if strangers.iter().all(confirmed) {
            return Standing::Confirmed;
        }
        Standing::Unconfirmed {
            names: strangers.iter().map(|a| a.name.clone()).collect(),
        }
    }

    /// Remember that the user confirmed a command for every automation behind it
    /// that is not their own. An error when there is none, or it cannot be saved.
    pub fn confirm(
        &mut self,
        library: &AutomationStore,
        chain: &[String],
        program: &str,
        args: &[String],
        path: &Path,
    ) -> Result<(), String> {
        let ids: Vec<String> = self
            .strangers(library, chain, program, args)
            .ok_or("The command does not belong to a saved automation.")?
            .iter()
            .map(|a| a.id.clone())
            .collect();
        let command = ConfirmedCommand::new(path, args);
        let before = self.trust.clone();
        for id in ids {
            if !self.is_confirmed(&id, &command.key()) {
                let commands = self.trust.confirmed.entry(id).or_default();
                commands.push(command.clone());
            }
        }
        self.save_or_restore(before, "The confirmation could not be saved.")
    }

    fn is_confirmed(&self, id: &str, hash: &str) -> bool {
        let commands = self.trust.confirmed.get(id);
        commands.is_some_and(|commands| commands.iter().any(|c| c.key() == hash))
    }

    fn save_or_restore(&mut self, before: AutomationTrust, failed: &str) -> Result<(), String> {
        if self.save() {
            return Ok(());
        }
        self.trust = before;
        Err(failed.to_string())
    }

    /// The confirmed commands of every automation that has any.
    pub fn confirmed(&self) -> &BTreeMap<String, Vec<ConfirmedCommand>> {
        &self.trust.confirmed
    }

    /// Take confirmations back: one command of an automation (`key`), all of one
    /// automation, or all.
    pub fn revoke(&mut self, id: Option<&str>, key: Option<&str>) -> Result<(), String> {
        let before = self.trust.clone();
        match (id, key) {
            (None, _) => self.trust.confirmed.clear(),
            (Some(id), None) => {
                self.trust.confirmed.remove(id);
            }
            (Some(id), Some(key)) => {
                if let Some(commands) = self.trust.confirmed.get_mut(id) {
                    commands.retain(|c| c.key() != key);
                    if commands.is_empty() {
                        self.trust.confirmed.remove(id);
                    }
                }
            }
        }
        self.save_or_restore(before, "The confirmation could not be taken back.")
    }
}

/// On the first start with this check, a restore that an older build prepared would
/// be applied before the library is listed as the user's own. List what is there
/// now instead, so that what the restore brings is asked about.
pub fn adopt_before_restore(config_dir: &Path) {
    let storage = StoreFile::<AutomationTrust>::in_dir(config_dir);
    if storage.path().exists() || !config_dir.join(PENDING_DIR).exists() {
        return;
    }
    let raw = std::fs::read_to_string(config_dir.join(AutomationStore::FILE_NAME));
    let library = match raw.map(|raw| load_versioned::<AutomationStore>(&raw)) {
        Ok(LoadOutcome::Loaded { data, .. }) => data,
        _ => AutomationStore::default(),
    };
    let mut book = TrustBook {
        trust: AutomationTrust::default(),
        storage,
    };
    book.adopt(&library);
    book.save();
}

#[cfg(test)]
#[path = "trust_tests.rs"]
mod tests;

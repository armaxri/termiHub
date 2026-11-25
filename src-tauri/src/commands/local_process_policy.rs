//! Which program a "Run local process" step may start (#5994).
//!
//! The one place that decides it, for every origin, at the moment of starting:
//! [`judge`] turns the program of a step into one absolute file and says whether
//! the user's settings allow it. The caller spawns exactly that file.
//!
//! # The rule
//!
//! 1. Experimental features and the local-program opt-in must both be on.
//! 2. The program is trimmed and must be unambiguous: no control or text-direction
//!    characters, and on Windows no form that names another file than it shows
//!    (`C:tool`, `\tool`, `tool.exe.`, `tool.exe:stream`, `\\?\…`).
//! 3. It is resolved: an absolute path is itself; a path with a separator is taken
//!    from the app's working directory; a bare name is searched in the **absolute**
//!    directories of `PATH` (an empty or relative entry would mean the working
//!    directory). On Windows only `.exe` is added to a name without an extension.
//! 4. It is allowed when an entry of the list **equals** the program as written or
//!    the resolved path. Nothing is normalized, case-folded or canonicalized, so no
//!    other spelling and no other name of the same file can match an entry.
//!    Arguments are not part of the rule.
//!
//! A program that is not on the list starts only with the path the user approved
//! for this run, which must be the one it still resolves to.
//!
//! # What this does not protect against
//!
//! - **A compromised window.** The list lives in the settings, which the window
//!   writes (`save_settings`) and a restored backup brings (#6018), and the window
//!   reports the user's approval. Code
//!   running in a window can also open a local shell and type into it. This check
//!   protects against automations (files, imports, triggers) and against a mistake
//!   in the frontend, not against the frontend itself.
//! - **Arguments.** Allowing an interpreter or a build tool (`sh`, `python`,
//!   `make`, `git`) allows everything it can be told to do.
//! - **Someone who can write to the allowed file, to a symbolic link on its path,
//!   or to a `PATH` directory** (for an entry that is a bare name): the file can be
//!   replaced at any time, also between this check and the start.
//! - **The environment and the working directory** are the app's own.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::connection::settings::AppSettings;

/// Where the user allows programs, for messages.
const WHERE_ALLOWED: &str = "Run it by hand once and choose \"Always allow\". Allowed programs \
                             are listed in Settings ▸ Security.";

/// What programs are resolved against.
#[derive(Debug, Clone)]
pub struct SearchEnv {
    /// The `PATH` variable.
    pub path: Option<OsString>,
    /// The app's working directory.
    pub cwd: Option<PathBuf>,
    /// Whether Windows naming rules apply.
    pub windows: bool,
}

impl SearchEnv {
    /// The running app's.
    pub fn current() -> Self {
        Self {
            path: std::env::var_os("PATH"),
            cwd: std::env::current_dir().ok(),
            windows: cfg!(windows),
        }
    }
}

/// The verdict on a program, as the frontend gets it before it starts one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum LocalProcessCheck {
    /// On the list: it may start.
    Allowed {
        /// The file that would be started.
        path: String,
    },
    /// Not on the list: it may start only if the user approves this file.
    Ask {
        /// The file that would be started.
        path: String,
        /// Why it does not start by itself, and where to allow it.
        reason: String,
    },
    /// It must not start, approved or not.
    Refused {
        /// Why.
        reason: String,
    },
}

/// The file to start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Program {
    /// The absolute file.
    pub path: PathBuf,
    /// The bare name it was found by; `None` for a path.
    pub bare_name: Option<String>,
}

/// A program with the verdict on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Judged {
    /// The file to start.
    pub program: Program,
    /// Whether the list has it; otherwise why not, and where to allow it.
    pub listed: Result<(), String>,
}

/// Judge `program` by `settings` (`None` when they cannot be read). An error is a
/// refusal that no approval lifts.
pub fn judge(
    settings: Option<&AppSettings>,
    program: &str,
    env: &SearchEnv,
) -> Result<Judged, String> {
    let name = program.trim();
    // First, so that no message shows a name that does not read as it is.
    if let Some(problem) = ambiguous(name, env.windows) {
        return Err(format!("The program was not started: {problem}."));
    }
    let settings = settings.ok_or_else(|| {
        format!("\"{name}\" was not started: the settings that allow programs cannot be read.")
    })?;
    if settings.experimental_features_enabled != Some(true) {
        return Err(format!(
            "\"{name}\" was not started: running a local process is experimental. Turn on \
             Settings ▸ General ▸ Allow experimental features."
        ));
    }
    if !settings.workflow_local_process_enabled {
        return Err(format!(
            "\"{name}\" was not started: local programs are off. Turn on Settings ▸ Security ▸ \
             Allow automations to run local programs."
        ));
    }
    let program = resolve(name, env)?;
    let path = program.path.to_str();
    let listed = settings
        .workflow_local_process_allowlist
        .iter()
        .map(|entry| entry.trim())
        .any(|entry| entry == name || Some(entry) == path);
    Ok(Judged {
        listed: if listed {
            Ok(())
        } else {
            Err(format!(
                "\"{name}\" ({}) is not an allowed program. {WHERE_ALLOWED}",
                program.path.display()
            ))
        },
        program,
    })
}

/// The program to start now: a listed one, or the one the user approved for this
/// run (`approved_path`, as [`LocalProcessCheck::Ask`] named it).
pub fn authorize(
    settings: Option<&AppSettings>,
    program: &str,
    approved_path: Option<&str>,
    env: &SearchEnv,
) -> Result<Program, String> {
    let judged = judge(settings, program, env)?;
    match (judged.listed, approved_path) {
        (Ok(()), _) => Ok(judged.program),
        (Err(_), Some(approved)) if judged.program.path.to_str() == Some(approved) => {
            Ok(judged.program)
        }
        (Err(_), Some(approved)) => Err(format!(
            "\"{}\" was not started: \"{approved}\" was approved, but it is {} now.",
            program.trim(),
            judged.program.path.display()
        )),
        (Err(reason), None) => Err(reason),
    }
}

/// The verdict for the frontend.
pub fn check(settings: Option<&AppSettings>, program: &str, env: &SearchEnv) -> LocalProcessCheck {
    match judge(settings, program, env) {
        Err(reason) => LocalProcessCheck::Refused { reason },
        Ok(Judged { program, listed }) => match (program.path.to_str(), listed) {
            // An approval names the path, so one that is no text cannot be given.
            (None, _) => LocalProcessCheck::Refused {
                reason: format!("{} has no readable name.", program.path.display()),
            },
            (Some(path), Ok(())) => LocalProcessCheck::Allowed { path: path.into() },
            (Some(path), Err(reason)) => LocalProcessCheck::Ask {
                path: path.into(),
                reason,
            },
        },
    }
}

/// Why `name` does not plainly name one program, if it does not.
fn ambiguous(name: &str, windows: bool) -> Option<&'static str> {
    if name.is_empty() {
        return Some("no program is set");
    }
    if name.chars().any(|c| c.is_control() || is_hidden(c)) {
        return Some("its name has invisible or text-direction characters");
    }
    if !windows {
        return None;
    }
    let bytes = name.as_bytes();
    let separator = |c: char| c == '/' || c == '\\';
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    let rest = if drive { &name[2..] } else { name };
    if name.starts_with(r"\\?\") || name.starts_with(r"\\.\") || name.starts_with("//?/") {
        return Some("device paths are not supported");
    }
    if drive && !rest.starts_with(separator) {
        return Some("a path on a drive must be complete (C:\\…)");
    }
    if !drive && rest.starts_with(separator) && !name.starts_with(r"\\") && !name.starts_with("//")
    {
        return Some("a path must start with its drive (C:\\…)");
    }
    if rest.contains(['"', '<', '>', '|', '?', '*', ':']) {
        return Some("its name has a character that Windows does not allow");
    }
    // Windows drops these, so the name shown would not be the file started.
    if rest
        .split(separator)
        .any(|part| part.ends_with(' ') || (part.ends_with('.') && part != "." && part != ".."))
    {
        return Some("a part of its path ends in a dot or a space");
    }
    None
}

/// Characters that show nothing or change the direction text is shown in, so that
/// a name can read as another one.
fn is_hidden(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200F}' | '\u{061C}' | '\u{FEFF}'
        | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}')
}

/// Resolve `name` to one existing file.
fn resolve(name: &str, env: &SearchEnv) -> Result<Program, String> {
    let is_path = name.contains('/') || (env.windows && name.contains('\\'));
    let last = name.rsplit(['/', '\\']).next().unwrap_or(name);
    // As the OS would: a name without an extension is an .exe. Never a script
    // (.bat, .cmd), which PATHEXT would also offer.
    let file_name = if env.windows && !last.contains('.') {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let not_found = || format!("\"{name}\" was not started: no such program was found.");
    let path = if is_path {
        let path = Path::new(&file_name);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            let cwd = env.cwd.as_ref().ok_or_else(not_found)?;
            std::path::absolute(cwd.join(path)).map_err(|_| not_found())?
        }
    } else {
        search(&file_name, env).ok_or_else(not_found)?
    };
    if !path.is_absolute() || !is_program_file(&path, env.windows) {
        return Err(not_found());
    }
    Ok(Program {
        path,
        bare_name: (!is_path).then(|| name.to_string()),
    })
}

/// Whether `path` is a file that can be started. A Windows app execution alias (the
/// Store's `python.exe`, `winget.exe`) is a reparse point that only the OS can
/// follow, so reading what it stands for fails while it starts fine.
fn is_program_file(path: &Path, windows: bool) -> bool {
    match path.metadata() {
        Ok(metadata) => metadata.is_file(),
        Err(_) => windows && path.symlink_metadata().is_ok_and(|m| !m.is_dir()),
    }
}

/// Search a bare name in the absolute directories of `PATH`.
fn search(file_name: &str, env: &SearchEnv) -> Option<PathBuf> {
    let dirs: Vec<PathBuf> = std::env::split_paths(env.path.as_ref()?)
        .filter(|dir| dir.is_absolute())
        .collect();
    if dirs.is_empty() {
        return None; // An empty PATH would mean the working directory.
    }
    let path = std::env::join_paths(dirs).ok()?;
    which::which_in_global(file_name, Some(path)).ok()?.next()
}

#[cfg(test)]
#[path = "local_process_policy_tests.rs"]
mod tests;

//! Higher-level SFTP capability operations shared by every SFTP path.
//!
//! Where [`sftp`](super::sftp) holds the low-level russh-sftp *mechanics*
//! (subsystem open, `readdir`/`stat` -> `FileEntry` mapping), this module holds
//! the capability *operations* that the desktop file browser historically owned
//! alone (#2075/#2104):
//!
//! * [`check_writable`] — a non-destructive write-open probe that reports the
//!   connecting user's *actual* ability to write a file (catching the
//!   owner-mismatch case the cheap permission hint cannot), plus the
//!   [`Writability`] verdict it yields.
//! * [`write_file_content_elevated`] — a privilege-elevated (`sudo`) remote write
//!   (#1323/#1328): SFTP-upload the buffer to a tool-generated temp path, then
//!   `sudo -S` a fixed `/bin/sh` script that rewrites the destination in place,
//!   classified into a typed [`ElevatedWriteResult`].
//! * [`realpath`] — resolve a remote path to its canonical absolute form via SFTP
//!   `realpath` (audit GAP C2, #1143).
//!
//! Both the core [`FileBrowser`](crate::files::FileBrowser) path and the desktop
//! `SftpSession` now consume these once, so the security-sensitive `sudo`
//! command composition and the writability classification can never drift
//! between two forks.

use russh_sftp::client::error::Error as RusshSftpError;
use russh_sftp::client::SftpSession as RusshSftp;
use russh_sftp::protocol::{OpenFlags, StatusCode};
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tracing::{debug, warn};

use crate::errors::FileError;

use super::exec::ssh_exec_with_stdin;
use super::handler::SshSession;

/// Authoritative writability of a specific remote file, as decided by an SFTP
/// write-open probe (see [`check_writable`]).
///
/// Unlike the cheap permission-string hint on
/// [`FileEntry`](crate::files::FileEntry), this reflects the connecting user's
/// *actual* ability to open the file for writing — it catches the owner-mismatch
/// case (e.g. a `rw-r--r--` file owned by another user).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub enum Writability {
    /// The file could be opened for writing.
    Writable,
    /// The server denied the write-open with `PERMISSION_DENIED`.
    ReadOnly,
    /// The probe could not conclude (any other error) — treat as writable by the
    /// caller (attempt the write) so a false negative never blocks a save.
    Unknown,
}

/// Classify a failed write-open probe into a [`Writability`].
///
/// A `PERMISSION_DENIED` status is the authoritative "read-only" signal; every
/// other error (missing file, transport hiccup, unsupported op, …) is
/// inconclusive and maps to [`Writability::Unknown`] rather than a hard failure.
fn classify_write_open_error(err: &RusshSftpError) -> Writability {
    match err {
        RusshSftpError::Status(status) if status.status_code == StatusCode::PermissionDenied => {
            Writability::ReadOnly
        }
        _ => Writability::Unknown,
    }
}

/// Authoritatively probe whether the connecting user can write `remote_path`.
///
/// Opens the **existing** file for writing with `OpenFlags::WRITE` only — no
/// `CREATE`, no `TRUNCATE`, no `APPEND` — so the file's contents are never
/// modified; the handle is immediately shut down. This catches the
/// owner-mismatch case the cheap permission hint cannot (a `rw-r--r--` file
/// owned by another user). Never returns a hard error for the ambiguous case:
/// a `PERMISSION_DENIED` maps to [`Writability::ReadOnly`], any other error to
/// [`Writability::Unknown`] (logged, not propagated).
pub async fn check_writable(sftp: &RusshSftp, remote_path: &str) -> Writability {
    match sftp.open_with_flags(remote_path, OpenFlags::WRITE).await {
        Ok(mut file) => {
            // Wrote nothing; close the handle so the server releases it.
            if let Err(e) = file.shutdown().await {
                warn!(error = %e, "SFTP write probe: closing probe handle failed");
            }
            debug!("SFTP write probe: writable");
            Writability::Writable
        }
        Err(e) => {
            let writability = classify_write_open_error(&e);
            match writability {
                Writability::ReadOnly => {
                    debug!("SFTP write probe: read-only (permission denied)")
                }
                _ => warn!(error = %e, "SFTP write probe: inconclusive, treating as unknown"),
            }
            writability
        }
    }
}

/// Resolve a remote path to its canonical absolute form via SFTP realpath.
///
/// Passing `"."` yields the session's home directory, avoiding the fragile
/// `/home/<user>` guess that breaks on non-Linux layouts (audit GAP C2,
/// issue #1143).
pub async fn realpath(sftp: &RusshSftp, path: &str) -> Result<String, FileError> {
    sftp.canonicalize(path)
        .await
        .map_err(|e| FileError::OperationFailed(format!("realpath failed: {e}")))
}

/// Outcome of a privilege-elevated (`sudo`) remote write (issue #1328).
///
/// Serializes adjacently-tagged so the frontend can `switch` on `kind`:
/// `{ "kind": "success" }`, `{ "kind": "incorrectPassword" }`, or
/// `{ "kind": "other", "message": "…" }`. `IncorrectPassword` is the only
/// re-promptable case; `Other` carries a human-readable reason (sudo missing,
/// not in sudoers, `requiretty`, a write error, …).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum ElevatedWriteResult {
    /// The destination file was rewritten with root privileges.
    Success,
    /// The supplied sudo password was rejected — safe to re-prompt.
    IncorrectPassword,
    /// Any other failure, with a message suitable for display.
    Other(String),
}

/// Line the elevated script prints on **stdout** before it touches any file.
///
/// It can only appear once sudo has authenticated *and* authorized the command
/// (the script runs as root), so its presence is a locale-independent proof
/// that sudo itself succeeded — any later failure is a write error, never a
/// password problem (#4290).
const SUDO_AUTHORIZED_MARKER: &str = "termihub-sudo-authorized";

/// Fixed shell script executed under `sudo` to rewrite the destination from the
/// uploaded temp file, then delete the temp.
///
/// First echoes [`SUDO_AUTHORIZED_MARKER`] (kept in sync by a unit test), then
/// rewrites the file. Uses **positional parameters** — `$1` is the temp path,
/// `$2` the destination — so the actual paths travel as separate `argv` words
/// and are *never* interpolated into this script body. `cat "$1" > "$2"` (not
/// `mv`) preserves the destination's existing owner, mode, and ACLs by
/// rewriting in place.
const ELEVATED_WRITE_SCRIPT: &str =
    r#"echo termihub-sudo-authorized && cat "$1" > "$2" && rm -f "$1""#;

/// Pins sudo's *own* message locale (#4290, I18N2-001).
///
/// sudo and PAM translate their messages — and PAM's password prompt — through
/// gettext under the remote user's locale. Exec'ing sudo through `env` with
/// `LC_ALL=C LANG=C LANGUAGE=` forces the untranslated C locale for sudo's
/// process regardless of the remote login shell (`env` works the same from
/// sh, bash, zsh, fish and csh), and keeps PAM's default `Password:` prompt
/// recognisable so sudo substitutes our unique `-p` prompt for it.
const SUDO_C_LOCALE_PREFIX: &str = "env LC_ALL=C LANG=C LANGUAGE=";

/// Exit status `env` returns when it cannot find (127) or execute (126) the
/// command — i.e. sudo is not installed or not on the login `PATH`.
const ENV_COMMAND_NOT_FOUND: i32 = 127;
const ENV_COMMAND_NOT_EXECUTABLE: i32 = 126;

/// Generate a termiHub-owned temp upload path: `/tmp/termihub-<uuid-v4>`.
///
/// The name is entirely tool-generated (a fresh v4 UUID), so no user or remote
/// text ever forms the temp path.
fn elevated_temp_path() -> String {
    format!("/tmp/termihub-{}", uuid::Uuid::new_v4())
}

/// Generate a unique, per-attempt sudo password prompt.
///
/// sudo writes the `-p` prompt to stderr each time it asks for the password, so
/// counting this token in stderr tells how many password attempts sudo made —
/// without reading a single (possibly translated) message. It contains no `%`
/// (sudo would expand `%u`/`%h` escapes) and no shell metacharacters.
fn sudo_prompt_token() -> String {
    format!("[termihub-sudo-prompt-{}]", uuid::Uuid::new_v4().simple())
}

/// POSIX-quote a path so it survives the remote login shell as a single word.
///
/// Wraps [`shlex::try_quote`]; fails only on a NUL byte (not a valid path).
fn shell_quote(path: &str) -> Result<String, FileError> {
    shlex::try_quote(path)
        .map(|q| q.into_owned())
        .map_err(|e| FileError::OperationFailed(format!("cannot quote path for remote shell: {e}")))
}

/// Build the `sudo -S` command that rewrites `dest_path` from `temp_path`.
///
/// * `env LC_ALL=C LANG=C LANGUAGE=` pins sudo's message locale
///   ([`SUDO_C_LOCALE_PREFIX`]).
/// * `-k` ignores any cached sudo timestamp, so the supplied password is always
///   verified (a stale stored password is detected even if an earlier terminal
///   session left sudo's credential cache warm). `-n` is deliberately **not**
///   used: it would fail instead of reading the password we supply.
/// * `-S -p <prompt>` reads the password from **stdin** and writes the unique
///   `prompt` to stderr on every attempt. The password is never on the command
///   line.
///
/// The script body is the fixed [`ELEVATED_WRITE_SCRIPT`] literal (single-quoted,
/// so the remote shell passes it verbatim to `/bin/sh -c`); the temp and
/// destination paths follow as quoted positional arguments (`$1`, `$2`). The
/// destination is untrusted remote text, so it is POSIX-quoted — a path with
/// spaces, quotes, `;`, or `$(…)` cannot break out of the command.
fn build_sudo_write_command(
    temp_path: &str,
    dest_path: &str,
    prompt: &str,
) -> Result<String, FileError> {
    let prompt_is_safe = !prompt.is_empty()
        && prompt
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '[' | ']' | ':'));
    if !prompt_is_safe {
        return Err(FileError::OperationFailed(
            "invalid sudo prompt token".to_string(),
        ));
    }
    let temp_q = shell_quote(temp_path)?;
    let dest_q = shell_quote(dest_path)?;
    // `sh` becomes $0; temp is $1, dest is $2.
    Ok(format!(
        "{SUDO_C_LOCALE_PREFIX} sudo -k -S -p '{prompt}' /bin/sh -c '{ELEVATED_WRITE_SCRIPT}' \
         sh {temp_q} {dest_q}"
    ))
}

/// Build the stdin payload carrying the sudo password: exactly one line.
///
/// A password containing a line break (or NUL) cannot be sent as a single
/// `sudo -S` line — the remainder would be read as a *second* password attempt
/// — so it is refused up front with a displayable message.
fn sudo_password_stdin(password: &str) -> Result<String, String> {
    if password.contains(['\n', '\r', '\0']) {
        return Err("The sudo password cannot contain line breaks.".to_string());
    }
    Ok(format!("{password}\n"))
}

/// Build the best-effort cleanup command that removes the temp upload.
///
/// Run as the connecting user (who owns the temp file) on any failure path so
/// the temp never leaks; on success the sudo script already removed it.
fn build_cleanup_command(temp_path: &str) -> Result<String, FileError> {
    Ok(format!("rm -f {}", shell_quote(temp_path)?))
}

/// Fine-grained, locale-independent classification of an elevated sudo exec.
///
/// Mapped onto the wire-level [`ElevatedWriteResult`] by
/// [`SudoOutcome::into_result`].
#[derive(Debug, Clone, PartialEq, Eq)]
enum SudoOutcome {
    /// sudo authorized the command and the rewrite succeeded.
    Success,
    /// sudo rejected the password (it re-prompted) — safe to re-prompt.
    IncorrectPassword,
    /// sudo is not installed / not on the remote login `PATH`.
    SudoMissing,
    /// The password was accepted but sudoers does not allow the command.
    NotPermitted,
    /// sudo refuses to run without a terminal (`Defaults requiretty`).
    RequiresTty,
    /// sudo authorized the command, but rewriting the file failed.
    WriteFailed(String),
    /// Any other sudo failure, with its first stderr line.
    Failed(String),
}

impl SudoOutcome {
    /// Map onto the frontend-facing result, with a clear displayable message.
    fn into_result(self) -> ElevatedWriteResult {
        match self {
            Self::Success => ElevatedWriteResult::Success,
            Self::IncorrectPassword => ElevatedWriteResult::IncorrectPassword,
            Self::SudoMissing => ElevatedWriteResult::Other(
                "sudo is not installed on the remote host (or not on the login PATH).".to_string(),
            ),
            Self::NotPermitted => ElevatedWriteResult::Other(
                "The password was accepted, but this user is not allowed to use sudo on the \
                 remote host (not in the sudoers file)."
                    .to_string(),
            ),
            Self::RequiresTty => ElevatedWriteResult::Other(
                "sudo on the remote host requires a terminal (requiretty), so elevated save \
                 cannot use it."
                    .to_string(),
            ),
            Self::WriteFailed(msg) => {
                ElevatedWriteResult::Other(format!("Writing the file as root failed: {msg}"))
            }
            Self::Failed(msg) => ElevatedWriteResult::Other(msg),
        }
    }
}

/// First non-empty stderr line with every occurrence of the sudo prompt removed,
/// or a fallback naming the exit status (so the UI never shows a blank error).
fn first_stderr_line(stderr: &str, prompt: &str, exit_status: i32) -> String {
    let cleaned = stderr.replace(prompt, "\n");
    cleaned
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("sudo failed (exit status {exit_status})"))
}

/// Classify a completed sudo exec into a [`SudoOutcome`] — locale-independently.
///
/// The decision rests on structural signals, never on translated text:
///
/// 1. [`SUDO_AUTHORIZED_MARKER`] on stdout means sudo authorized the command
///    (the script ran as root): exit 0 is [`SudoOutcome::Success`], anything
///    else a [`SudoOutcome::WriteFailed`]. A zero exit *without* the marker is
///    never trusted as success.
/// 2. Otherwise count the unique `prompt` in stderr. stdin carries exactly one
///    password line, so sudo asking **twice or more** means it rejected the
///    first password and re-prompted → [`SudoOutcome::IncorrectPassword`].
/// 3. Asked **once** and not re-asked: the password was accepted but sudo still
///    refused → [`SudoOutcome::NotPermitted`].
/// 4. Never asked and `env` reported 127/126 → [`SudoOutcome::SudoMissing`].
///
/// Because the command pins sudo to the C locale, the remaining refinements may
/// consult sudo's *untranslated* C-locale wording, used only to sub-classify:
/// `requiretty` (no prompt; "must have a tty") and a `passwd_tries=1` policy
/// (one prompt, "incorrect password attempt"). No translated string is ever
/// matched.
fn classify_sudo_output(stdout: &str, stderr: &str, exit_status: i32, prompt: &str) -> SudoOutcome {
    if stdout.lines().any(|l| l.trim() == SUDO_AUTHORIZED_MARKER) {
        return if exit_status == 0 {
            SudoOutcome::Success
        } else {
            SudoOutcome::WriteFailed(first_stderr_line(stderr, prompt, exit_status))
        };
    }
    let prompts = stderr.matches(prompt).count();
    let c_locale = stderr.to_ascii_lowercase();
    match prompts {
        0 if exit_status == ENV_COMMAND_NOT_FOUND || exit_status == ENV_COMMAND_NOT_EXECUTABLE => {
            SudoOutcome::SudoMissing
        }
        0 if c_locale.contains("must have a tty")
            || c_locale.contains("a terminal is required") =>
        {
            SudoOutcome::RequiresTty
        }
        0 if c_locale.contains("not in the sudoers") || c_locale.contains("not allowed to") => {
            SudoOutcome::NotPermitted
        }
        0 => SudoOutcome::Failed(first_stderr_line(stderr, prompt, exit_status)),
        1 if c_locale.contains("incorrect password attempt") => SudoOutcome::IncorrectPassword,
        1 => SudoOutcome::NotPermitted,
        _ => SudoOutcome::IncorrectPassword,
    }
}

/// Upload `content` to `temp_path` on `sftp`, creating or overwriting it.
///
/// The temp path is always tool-generated (`/tmp/termihub-<uuid>`), so it never
/// carries user or remote text.
async fn upload_temp(sftp: &RusshSftp, temp_path: &str, content: &[u8]) -> Result<(), FileError> {
    let mut remote = sftp
        .create(temp_path)
        .await
        .map_err(|e| FileError::OperationFailed(format!("create remote temp file: {e}")))?;
    remote
        .write_all(content)
        .await
        .map_err(|e| FileError::OperationFailed(format!("write remote temp file: {e}")))?;
    // `write_all` only queues the SFTP writes; their acks arrive later. Wait
    // for every ack and close the handle before the sudo exec runs, or `cat`
    // can read the temp before the server has written it (an empty or partial
    // destination), and a failed write would go unnoticed.
    remote
        .shutdown()
        .await
        .map_err(|e| FileError::OperationFailed(format!("finish remote temp file: {e}")))?;
    Ok(())
}

/// Best-effort removal of the temp upload as the connecting user; failures are
/// logged, not propagated (the caller is already returning an outcome).
async fn cleanup_elevated_temp(session: &SshSession, temp_path: &str) {
    match build_cleanup_command(temp_path) {
        Ok(cmd) => {
            if let Err(e) = ssh_exec_with_stdin(session, &cmd, "").await {
                warn!(error = %e, "elevated save: temp cleanup exec failed");
            }
        }
        Err(e) => warn!(error = %e, "elevated save: could not build cleanup command"),
    }
}

/// Write `content` to `remote_path` with `sudo`-elevated privileges (#1328).
///
/// Steps: (1) upload `content` to a termiHub-generated `/tmp/termihub-<uuid>`
/// via SFTP on `sftp`; (2) run `sudo -k -S -p <unique prompt>` under the C
/// locale on a fixed `/bin/sh` script that echoes an authorization marker, then
/// does `cat "$1" > "$2" && rm -f "$1"` — rewriting the destination in place
/// (preserving owner/mode/ACLs) and removing the temp — over `session`'s exec
/// channel with the sudo password supplied as a single stdin line; (3) classify
/// the result into [`ElevatedWriteResult`] from sudo's exit status, the marker,
/// and how often the unique prompt appeared — never from translated text. On
/// any non-success path the temp file is removed best-effort so it never leaks.
///
/// The destination path is POSIX-quoted and passed as a positional argument, so
/// a hostile remote path cannot inject shell commands. The password is only ever
/// sent on stdin and is **never** logged.
pub async fn write_file_content_elevated(
    session: &SshSession,
    sftp: &RusshSftp,
    remote_path: &str,
    content: &str,
    sudo_password: &str,
) -> Result<ElevatedWriteResult, FileError> {
    let temp_path = elevated_temp_path();
    debug!(
        remote_path,
        temp_path, "SFTP elevated save: uploading temp buffer"
    );

    // 1. Upload the buffer to the temp path via SFTP.
    if let Err(e) = upload_temp(sftp, &temp_path, content.as_bytes()).await {
        // Nothing durable was created if create/write failed, but attempt a
        // cleanup anyway in case a partial file exists.
        cleanup_elevated_temp(session, &temp_path).await;
        return Err(e);
    }

    // 2. Run the sudo rewrite. Password is one stdin line — never logged and
    //    never on the command line.
    let stdin = match sudo_password_stdin(sudo_password) {
        Ok(stdin) => stdin,
        Err(msg) => {
            cleanup_elevated_temp(session, &temp_path).await;
            return Ok(ElevatedWriteResult::Other(msg));
        }
    };
    let prompt = sudo_prompt_token();
    let command = build_sudo_write_command(&temp_path, remote_path, &prompt)?;
    let outcome = match ssh_exec_with_stdin(session, &command, &stdin).await {
        Ok(output) => {
            classify_sudo_output(&output.stdout, &output.stderr, output.exit_status, &prompt)
                .into_result()
        }
        Err(e) => ElevatedWriteResult::Other(e.to_string()),
    };

    // 3. On any failure, best-effort remove the temp (the sudo script only
    //    removes it on its own success).
    if outcome != ElevatedWriteResult::Success {
        cleanup_elevated_temp(session, &temp_path).await;
    }

    debug!(remote_path, ?outcome, "SFTP elevated save: completed");
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a synthetic SFTP status error for the given status code.
    fn status_error(code: StatusCode) -> RusshSftpError {
        RusshSftpError::Status(russh_sftp::protocol::Status {
            id: 0,
            status_code: code,
            error_message: String::new(),
            language_tag: String::new(),
        })
    }

    /// A `PERMISSION_DENIED` write-open is the authoritative read-only signal.
    #[test]
    fn classify_permission_denied_is_read_only() {
        let err = status_error(StatusCode::PermissionDenied);
        assert_eq!(classify_write_open_error(&err), Writability::ReadOnly);
    }

    /// Any other status (e.g. missing file) is inconclusive → Unknown.
    #[test]
    fn classify_other_status_is_unknown() {
        let err = status_error(StatusCode::NoSuchFile);
        assert_eq!(classify_write_open_error(&err), Writability::Unknown);
        let err = status_error(StatusCode::Failure);
        assert_eq!(classify_write_open_error(&err), Writability::Unknown);
    }

    /// Non-status errors (transport/protocol) are also inconclusive → Unknown.
    #[test]
    fn classify_non_status_error_is_unknown() {
        let err = RusshSftpError::Timeout;
        assert_eq!(classify_write_open_error(&err), Writability::Unknown);
    }

    /// `Writability` serializes as camelCase strings for the frontend.
    #[test]
    fn writability_serializes_camel_case() {
        assert_eq!(
            serde_json::to_value(Writability::ReadOnly).unwrap(),
            serde_json::json!("readOnly")
        );
        assert_eq!(
            serde_json::to_value(Writability::Writable).unwrap(),
            serde_json::json!("writable")
        );
        assert_eq!(
            serde_json::to_value(Writability::Unknown).unwrap(),
            serde_json::json!("unknown")
        );
    }

    // --- Elevated (sudo) save: command composition + classification (#1328) ---

    /// The termiHub-generated temp path has the expected `/tmp/termihub-<uuid>`
    /// shape (a v4 UUID suffix), so no user text ever forms the temp name.
    #[test]
    fn elevated_temp_path_has_expected_shape() {
        let path = elevated_temp_path();
        let suffix = path
            .strip_prefix("/tmp/termihub-")
            .expect("temp path must be under /tmp with the termihub- prefix");
        // The suffix must parse as a UUID (36 chars, hyphenated hex).
        uuid::Uuid::parse_str(suffix).expect("temp suffix must be a valid UUID");
        // Two calls must differ (fresh UUID each time).
        assert_ne!(path, elevated_temp_path());
    }

    /// Prompt token used by the classifier fixtures below.
    const PROMPT: &str = "[termihub-sudo-prompt-0123456789abcdef]";

    /// The sudo command pins the C locale through `env`, ignores cached
    /// credentials (`-k`), reads the password from stdin with the unique prompt
    /// (`-S -p '<token>'`), embeds the fixed script literal and passes both
    /// paths as positional argv (`$1` = temp, `$2` = dest).
    #[test]
    fn build_sudo_write_command_uses_fixed_script_and_argv() {
        let cmd = build_sudo_write_command("/tmp/termihub-abc", "/etc/hosts", PROMPT)
            .expect("clean paths must quote successfully");
        let expected_head = format!(
            "env LC_ALL=C LANG=C LANGUAGE= sudo -k -S -p '{PROMPT}' /bin/sh -c \
             'echo termihub-sudo-authorized && cat \"$1\" > \"$2\" && rm -f \"$1\"' sh "
        );
        assert!(
            cmd.starts_with(&expected_head),
            "command must lead with the C-locale env + sudo + script, got: {cmd}"
        );
        // The paths follow the script as separate argv words.
        assert!(cmd.ends_with(" /tmp/termihub-abc /etc/hosts"), "got: {cmd}");
        // `mv` must never be used — `cat >` preserves owner/mode/ACLs.
        assert!(!cmd.contains("mv "), "must use `cat >`, not `mv`");
        // `-n` would fail instead of reading the supplied password.
        assert!(!cmd.contains(" -n "), "must not use sudo -n, got: {cmd}");
    }

    /// Re-tokenized as shell words, the locale assignments are separate `env`
    /// arguments placed *before* sudo, so they apply to sudo's own process.
    #[test]
    fn build_sudo_write_command_pins_c_locale_for_sudo_process() {
        let cmd = build_sudo_write_command("/tmp/termihub-abc", "/etc/hosts", PROMPT).unwrap();
        let words = shlex::split(&cmd).expect("valid shell words");
        assert_eq!(
            &words[..6],
            &["env", "LC_ALL=C", "LANG=C", "LANGUAGE=", "sudo", "-k"],
            "got: {words:?}"
        );
        let p = words.iter().position(|w| w == "-p").expect("-p present");
        assert_eq!(words[p + 1], PROMPT, "prompt must be one word");
    }

    /// The script's leading echo is exactly the authorization marker the
    /// classifier looks for, so the two can never drift apart.
    #[test]
    fn elevated_script_echoes_authorization_marker_first() {
        assert!(
            ELEVATED_WRITE_SCRIPT.starts_with(&format!("echo {SUDO_AUTHORIZED_MARKER} && ")),
            "script must echo the marker before writing: {ELEVATED_WRITE_SCRIPT}"
        );
    }

    /// The password is never part of the command line; it travels only on
    /// stdin, as exactly one line.
    #[test]
    fn password_travels_only_on_stdin_as_one_line() {
        let secret = "s3cr3t-p@ss word";
        let cmd = build_sudo_write_command("/tmp/termihub-abc", "/etc/hosts", PROMPT).unwrap();
        assert!(!cmd.contains(secret));
        assert_eq!(sudo_password_stdin(secret).unwrap(), format!("{secret}\n"));
    }

    /// A password with a line break would be read as two attempts — refused.
    #[test]
    fn password_with_line_break_is_refused() {
        for bad in ["a\nb", "a\rb", "a\0b", "trailing\n"] {
            let err = sudo_password_stdin(bad).expect_err("line break must be refused");
            assert!(!err.contains(bad), "message must not echo the password");
        }
    }

    /// Generated prompt tokens are unique, `%`-free (sudo expands `%` escapes)
    /// and accepted by the builder.
    #[test]
    fn sudo_prompt_token_is_unique_and_safe() {
        let a = sudo_prompt_token();
        assert_ne!(a, sudo_prompt_token());
        assert!(!a.contains('%'));
        build_sudo_write_command("/tmp/t", "/etc/hosts", &a).expect("token must be accepted");
    }

    /// Prompts that could break out of the single quotes or trigger sudo `%`
    /// expansion are rejected by the builder.
    #[test]
    fn build_sudo_write_command_rejects_unsafe_prompt() {
        for bad in ["", "a'b", "%u", "a b", "$(x)"] {
            assert!(build_sudo_write_command("/tmp/t", "/etc/hosts", bad).is_err());
        }
    }

    /// A malicious destination path (spaces, quotes, shell metacharacters,
    /// command substitution, backticks) is quoted so it can never break out of
    /// the command. Proven by round-tripping: re-parsing the built command as
    /// shell words must yield the hostile path back as exactly ONE argument
    /// (the final one), so it lands as `$2` data — never as executable tokens.
    #[test]
    fn build_sudo_write_command_neutralizes_injection_in_dest() {
        for evil in [
            "/etc/foo'; rm -rf / #",
            "/x/$(reboot)",
            "/a/`reboot`",
            "/b/with space and \"quote\"",
            "/c/; shutdown -h now",
        ] {
            let temp = "/tmp/termihub-xyz";
            let cmd = build_sudo_write_command(temp, evil, PROMPT)
                .expect("even a hostile path must quote successfully");
            // The script body is always the untouched fixed literal.
            assert!(
                cmd.contains(&format!("/bin/sh -c '{ELEVATED_WRITE_SCRIPT}'")),
                "script literal must be intact, got: {cmd}"
            );
            // Re-tokenize the whole command as a shell would.
            let words = shlex::split(&cmd)
                .unwrap_or_else(|| panic!("built command must be valid shell words: {cmd}"));
            // The hostile path survives as the single final argument ($2), and
            // the temp path as the one before it ($1) — no breakout occurred.
            assert_eq!(
                words.last().map(String::as_str),
                Some(evil),
                "hostile dest must round-trip as one argument: {cmd}"
            );
            assert_eq!(
                words.get(words.len() - 2).map(String::as_str),
                Some(temp),
                "temp path must be the preceding argument: {cmd}"
            );
        }
    }

    /// The failure-cleanup command removes exactly the temp file, quoted.
    #[test]
    fn build_cleanup_command_removes_quoted_temp() {
        let cmd = build_cleanup_command("/tmp/termihub-abc").expect("clean path quotes");
        assert_eq!(cmd, "rm -f /tmp/termihub-abc");
        // A temp name is termiHub-generated so it never contains metachars, but
        // the builder still quotes defensively.
        let cmd = build_cleanup_command("/tmp/te mp").expect("quotes");
        assert_eq!(cmd, "rm -f '/tmp/te mp'");
    }

    /// Build sudo's stderr for `n` password prompts, each followed by `after`.
    fn prompted(n: usize, after: &[&str]) -> String {
        (0..n)
            .map(|i| format!("{PROMPT}{}\n", after.get(i).copied().unwrap_or("")))
            .collect()
    }

    const AUTHORIZED: &str = "termihub-sudo-authorized\n";

    /// The marker on stdout plus exit 0 is success — with or without a prompt
    /// (NOPASSWD rules never prompt), and regardless of stderr noise.
    #[test]
    fn classify_success_requires_marker_and_zero_exit() {
        assert_eq!(
            classify_sudo_output(AUTHORIZED, "", 0, PROMPT),
            SudoOutcome::Success
        );
        assert_eq!(
            classify_sudo_output(AUTHORIZED, &prompted(1, &[]), 0, PROMPT),
            SudoOutcome::Success
        );
        assert_eq!(
            classify_sudo_output(AUTHORIZED, "some warning\n", 0, PROMPT),
            SudoOutcome::Success
        );
    }

    /// A zero exit without the marker is never trusted as success.
    #[test]
    fn classify_zero_exit_without_marker_is_not_success() {
        assert_ne!(
            classify_sudo_output("", "", 0, PROMPT),
            SudoOutcome::Success
        );
    }

    /// Locale fixtures (C, de, fr, ja): sudo's re-prompt after a rejected
    /// password. The classifier keys off the prompt count only — the
    /// translated messages are irrelevant.
    const WRONG_PASSWORD_FIXTURES: &[(&str, &[&str], &str)] = &[
        (
            "C",
            &["Sorry, try again."],
            "sudo: no password was provided\nsudo: 1 incorrect password attempt\n",
        ),
        (
            "de",
            &["Entschuldigung, versuchen Sie es noch einmal."],
            "sudo: Es wurde kein Passwort angegeben\nsudo: 1 Fehlversuch bei der \
             Passworteingabe\n",
        ),
        (
            "fr",
            &["Désolé, essayez de nouveau."],
            "sudo: aucun mot de passe n'a été fourni\nsudo: 1 saisie de mot de passe \
             incorrecte\n",
        ),
        (
            "ja",
            &["申し訳ありません、もう一度試してください。"],
            "sudo: パスワードが入力されていません\nsudo: 1 回パスワードの入力を誤りました\n",
        ),
    ];

    #[test]
    fn classify_wrong_password_in_every_locale_by_prompt_count() {
        for (locale, after, tail) in WRONG_PASSWORD_FIXTURES {
            let stderr = format!("{}{tail}", prompted(2, after));
            assert_eq!(
                classify_sudo_output("", &stderr, 1, PROMPT),
                SudoOutcome::IncorrectPassword,
                "locale {locale}: {stderr:?}"
            );
            // Maps onto the re-promptable wire variant.
            assert_eq!(
                classify_sudo_output("", &stderr, 1, PROMPT).into_result(),
                ElevatedWriteResult::IncorrectPassword
            );
        }
    }

    /// Locale fixtures: the password was accepted (asked once, no re-prompt)
    /// but the user is not in sudoers. Classified by prompt count alone.
    #[test]
    fn classify_not_in_sudoers_in_every_locale() {
        for (locale, msg) in [
            (
                "C",
                "alice is not in the sudoers file.  This incident will be reported.",
            ),
            (
                "de",
                "alice ist nicht in der sudoers-Datei. Dieser Vorfall wird gemeldet.",
            ),
            (
                "fr",
                "alice n'apparaît pas dans le fichier sudoers. L'incident sera signalé.",
            ),
            (
                "ja",
                "alice は sudoers ファイル内にありません。この事象は記録・報告されます。",
            ),
        ] {
            let stderr = format!("{PROMPT}\n{msg}\n");
            let outcome = classify_sudo_output("", &stderr, 1, PROMPT);
            assert_eq!(outcome, SudoOutcome::NotPermitted, "locale {locale}");
            match outcome.into_result() {
                ElevatedWriteResult::Other(m) => assert!(m.contains("sudoers"), "{m}"),
                other => panic!("expected Other, got {other:?}"),
            }
        }
    }

    /// sudo not installed: `env` exits 127 (or 126) and no prompt was ever
    /// written — in any locale of `env`'s own message.
    #[test]
    fn classify_sudo_missing_by_env_exit_status() {
        for (stderr, code) in [
            ("env: 'sudo': No such file or directory\n", 127),
            ("env: „sudo“: Datei oder Verzeichnis nicht gefunden\n", 127),
            ("env: « sudo »: Aucun fichier ou dossier de ce type\n", 127),
            (
                "env: 'sudo': そのようなファイルやディレクトリはありません\n",
                127,
            ),
            ("env: 'sudo': Permission denied\n", 126),
            ("", 127),
        ] {
            let outcome = classify_sudo_output("", stderr, code, PROMPT);
            assert_eq!(outcome, SudoOutcome::SudoMissing, "{stderr:?}");
            match outcome.into_result() {
                ElevatedWriteResult::Other(m) => assert!(m.contains("not installed"), "{m}"),
                other => panic!("expected Other, got {other:?}"),
            }
        }
    }

    /// requiretty: sudo refuses before prompting. The command pins the C locale,
    /// so sudo's untranslated wording is what arrives.
    #[test]
    fn classify_requires_tty() {
        for stderr in [
            "sudo: sorry, you must have a tty to run sudo\n",
            "sudo: a terminal is required to read the password\n",
        ] {
            let outcome = classify_sudo_output("", stderr, 1, PROMPT);
            assert_eq!(outcome, SudoOutcome::RequiresTty, "{stderr:?}");
            match outcome.into_result() {
                ElevatedWriteResult::Other(m) => assert!(m.contains("terminal"), "{m}"),
                other => panic!("expected Other, got {other:?}"),
            }
        }
    }

    /// A `passwd_tries=1` policy never re-prompts; in the pinned C locale sudo
    /// still reports the failed attempt, which refines a single prompt.
    #[test]
    fn classify_single_try_policy_wrong_password() {
        let stderr = format!("{PROMPT}\nsudo: 1 incorrect password attempt\n");
        assert_eq!(
            classify_sudo_output("", &stderr, 1, PROMPT),
            SudoOutcome::IncorrectPassword
        );
    }

    /// sudo authorized the script (marker present) but the write failed — a
    /// write error, never a password problem, even with a prompt in stderr.
    #[test]
    fn classify_write_failure_after_authorization() {
        let stderr =
            format!("{PROMPT}/bin/sh: 1: cannot create /etc/hosts: Read-only file system\n");
        let outcome = classify_sudo_output(AUTHORIZED, &stderr, 2, PROMPT);
        assert_eq!(
            outcome,
            SudoOutcome::WriteFailed(
                "/bin/sh: 1: cannot create /etc/hosts: Read-only file system".to_string()
            )
        );
        match outcome.into_result() {
            ElevatedWriteResult::Other(m) => {
                assert!(
                    m.contains("Read-only file system") && !m.contains(PROMPT),
                    "{m}"
                )
            }
            other => panic!("expected Other, got {other:?}"),
        }
    }

    /// Unclassified failures carry the first stderr line (prompt stripped), or
    /// a non-empty fallback naming the exit status.
    #[test]
    fn classify_other_failures_carry_a_message() {
        assert_eq!(
            classify_sudo_output("", "sudo: unable to resolve host foo\n", 1, PROMPT),
            SudoOutcome::Failed("sudo: unable to resolve host foo".to_string())
        );
        match classify_sudo_output("", "   \n", 1, PROMPT) {
            SudoOutcome::Failed(m) => assert!(m.contains("exit status 1"), "{m}"),
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    /// The classifier contains no translated marker strings: swapping every
    /// fixture's localized text for gibberish yields identical outcomes.
    #[test]
    fn classify_ignores_localized_text_entirely() {
        let garbage = "\u{2603}\u{2603}\u{2603}";
        let cases = [
            (prompted(2, &[garbage]), 1, SudoOutcome::IncorrectPassword),
            (
                prompted(3, &[garbage, garbage]),
                1,
                SudoOutcome::IncorrectPassword,
            ),
            (
                format!("{PROMPT}\n{garbage}\n"),
                1,
                SudoOutcome::NotPermitted,
            ),
            (format!("{garbage}\n"), 127, SudoOutcome::SudoMissing),
        ];
        for (stderr, code, expected) in cases {
            assert_eq!(classify_sudo_output("", &stderr, code, PROMPT), expected);
        }
    }

    /// `ElevatedWriteResult` serializes to an adjacently-tagged JSON shape the
    /// frontend can switch on: `{kind}` for unit variants, `{kind, message}`
    /// for `Other`.
    #[test]
    fn elevated_write_result_serializes_for_frontend() {
        assert_eq!(
            serde_json::to_value(ElevatedWriteResult::Success).unwrap(),
            serde_json::json!({ "kind": "success" })
        );
        assert_eq!(
            serde_json::to_value(ElevatedWriteResult::IncorrectPassword).unwrap(),
            serde_json::json!({ "kind": "incorrectPassword" })
        );
        assert_eq!(
            serde_json::to_value(ElevatedWriteResult::Other("boom".to_string())).unwrap(),
            serde_json::json!({ "kind": "other", "message": "boom" })
        );
    }
}

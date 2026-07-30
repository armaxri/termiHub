//! Higher-level SFTP capability operations shared by every SFTP path.
//!
//! Where [`sftp`](super::sftp) holds the low-level russh-sftp *mechanics*
//! (subsystem open, `readdir`/`stat` -> [`FileEntry`] mapping), this module holds
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
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum ElevatedWriteResult {
    /// The destination file was rewritten with root privileges.
    Success,
    /// The supplied sudo password was rejected — safe to re-prompt.
    IncorrectPassword,
    /// Any other failure, with a message suitable for display.
    Other(String),
}

/// Fixed shell script executed under `sudo` to rewrite the destination from the
/// uploaded temp file, then delete the temp.
///
/// Uses **positional parameters** — `$1` is the temp path, `$2` the destination
/// — so the actual paths travel as separate `argv` words and are *never*
/// interpolated into this script body. `cat "$1" > "$2"` (not `mv`) preserves
/// the destination's existing owner, mode, and ACLs by rewriting in place.
const ELEVATED_WRITE_SCRIPT: &str = r#"cat "$1" > "$2" && rm -f "$1""#;

/// stderr substrings (lower-cased) that indicate sudo rejected the password and
/// the caller may safely re-prompt.
const SUDO_PASSWORD_MARKERS: &[&str] = &[
    "sorry, try again",
    "incorrect password",
    "no password was provided",
    "password is required",
];

/// Generate a termiHub-owned temp upload path: `/tmp/termihub-<uuid-v4>`.
///
/// The name is entirely tool-generated (a fresh v4 UUID), so no user or remote
/// text ever forms the temp path.
fn elevated_temp_path() -> String {
    format!("/tmp/termihub-{}", uuid::Uuid::new_v4())
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
/// `sudo -S -p ''` reads the password from **stdin** with no prompt echoed. The
/// script body is the fixed [`ELEVATED_WRITE_SCRIPT`] literal (single-quoted, so
/// the remote shell passes it verbatim to `/bin/sh -c`); the temp and
/// destination paths follow as quoted positional arguments (`$1`, `$2`). The
/// destination is untrusted remote text, so it is POSIX-quoted — a path with
/// spaces, quotes, `;`, or `$(…)` cannot break out of the command.
fn build_sudo_write_command(temp_path: &str, dest_path: &str) -> Result<String, FileError> {
    let temp_q = shell_quote(temp_path)?;
    let dest_q = shell_quote(dest_path)?;
    // `sh` becomes $0; temp is $1, dest is $2.
    Ok(format!(
        "sudo -S -p '' /bin/sh -c '{ELEVATED_WRITE_SCRIPT}' sh {temp_q} {dest_q}"
    ))
}

/// Build the best-effort cleanup command that removes the temp upload.
///
/// Run as the connecting user (who owns the temp file) on any failure path so
/// the temp never leaks; on success the sudo script already removed it.
fn build_cleanup_command(temp_path: &str) -> Result<String, FileError> {
    Ok(format!("rm -f {}", shell_quote(temp_path)?))
}

/// Classify a completed sudo exec into an [`ElevatedWriteResult`].
///
/// A zero exit is success. Otherwise, sudo's wrong-password convention
/// ("Sorry, try again.", "N incorrect password attempts", "no password was
/// provided") maps to [`ElevatedWriteResult::IncorrectPassword`]; everything
/// else (not in sudoers, sudo missing, `requiretty`, write errors) maps to
/// [`ElevatedWriteResult::Other`] with a displayable message.
fn classify_sudo_result(stderr: &str, exit_status: i32) -> ElevatedWriteResult {
    if exit_status == 0 {
        return ElevatedWriteResult::Success;
    }
    let lower = stderr.to_lowercase();
    if SUDO_PASSWORD_MARKERS.iter().any(|m| lower.contains(m)) {
        return ElevatedWriteResult::IncorrectPassword;
    }
    let message = stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("sudo failed (exit status {exit_status})"));
    ElevatedWriteResult::Other(message)
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
/// via SFTP on `sftp`; (2) `sudo -S -p ''` a fixed `/bin/sh` script that does
/// `cat "$1" > "$2" && rm -f "$1"` — rewriting the destination in place
/// (preserving owner/mode/ACLs) and removing the temp — over `session`'s exec
/// channel with the sudo password supplied as a single stdin line; (3) classify
/// the result into [`ElevatedWriteResult`]. On any non-success path the temp
/// file is removed best-effort so it never leaks.
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

    // 2. Run the sudo rewrite. Password is one stdin line — never logged.
    let command = build_sudo_write_command(&temp_path, remote_path)?;
    let stdin = format!("{sudo_password}\n");
    let outcome = match ssh_exec_with_stdin(session, &command, &stdin).await {
        Ok(output) => classify_sudo_result(&output.stderr, output.exit_status),
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

    /// The sudo command embeds the fixed script literal and passes both paths as
    /// positional argv (`$1` = temp, `$2` = dest) — never interpolated into the
    /// script body — with `sudo -S -p ''` reading the password from stdin.
    #[test]
    fn build_sudo_write_command_uses_fixed_script_and_argv() {
        let cmd = build_sudo_write_command("/tmp/termihub-abc", "/etc/hosts")
            .expect("clean paths must quote successfully");
        assert!(
            cmd.starts_with("sudo -S -p '' /bin/sh -c 'cat \"$1\" > \"$2\" && rm -f \"$1\"' sh "),
            "command must lead with sudo + the fixed single-quoted script literal, got: {cmd}"
        );
        // The paths follow the script as separate argv words.
        assert!(cmd.ends_with(" /tmp/termihub-abc /etc/hosts"), "got: {cmd}");
        // `mv` must never be used — `cat >` preserves owner/mode/ACLs.
        assert!(!cmd.contains("mv "), "must use `cat >`, not `mv`");
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
            let cmd = build_sudo_write_command(temp, evil)
                .expect("even a hostile path must quote successfully");
            // The script body is always the untouched fixed literal.
            assert!(
                cmd.contains("/bin/sh -c 'cat \"$1\" > \"$2\" && rm -f \"$1\"'"),
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

    /// A zero exit status is an unconditional success.
    #[test]
    fn classify_success_on_zero_exit() {
        assert_eq!(classify_sudo_result("", 0), ElevatedWriteResult::Success);
        // Even stray stderr noise with exit 0 is success.
        assert_eq!(
            classify_sudo_result("some warning\n", 0),
            ElevatedWriteResult::Success
        );
    }

    /// sudo's wrong-password convention ("Sorry, try again." /
    /// "N incorrect password attempts") maps to the re-promptable variant.
    #[test]
    fn classify_incorrect_password_from_sudo_stderr() {
        for stderr in [
            "Sorry, try again.\n",
            "[sudo] password for alice: \nSorry, try again.\nsudo: 1 incorrect password attempt\n",
            "sudo: 3 incorrect password attempts\n",
            "sudo: no password was provided\n",
            "sudo: a password is required\n",
        ] {
            assert_eq!(
                classify_sudo_result(stderr, 1),
                ElevatedWriteResult::IncorrectPassword,
                "stderr should classify as IncorrectPassword: {stderr:?}"
            );
        }
    }

    /// sudo-not-permitted, missing sudo, requiretty, and write errors all map to
    /// `Other` carrying a message (never mistaken for a wrong password).
    #[test]
    fn classify_other_for_non_password_failures() {
        let cases = [
            "alice is not in the sudoers file.  This incident will be reported.\n",
            "sudo: command not found\n",
            "sudo: sorry, you must have a tty to run sudo\n",
            "/bin/sh: 1: cannot create /etc/hosts: Permission denied\n",
        ];
        for stderr in cases {
            match classify_sudo_result(stderr, 1) {
                ElevatedWriteResult::Other(msg) => {
                    assert!(
                        !msg.is_empty(),
                        "Other message must be populated: {stderr:?}"
                    );
                }
                other => panic!("expected Other for {stderr:?}, got {other:?}"),
            }
        }
    }

    /// A non-zero exit with empty stderr still classifies as `Other` with a
    /// non-empty fallback message (so the UI never shows a blank error).
    #[test]
    fn classify_other_with_fallback_when_stderr_empty() {
        match classify_sudo_result("   \n", 127) {
            ElevatedWriteResult::Other(msg) => assert!(msg.contains("127")),
            other => panic!("expected Other, got {other:?}"),
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

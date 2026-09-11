//! Docker container file browser implementing [`FileBrowser`].
//!
//! Uses bollard's exec API to run commands inside a running container
//! for file listing, reading, writing, deleting, renaming, and stat.

use base64::Engine as _;
use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;

use crate::errors::FileError;
use crate::files::utils::{chrono_from_epoch, format_permissions};
use crate::files::{FileBrowser, FileEntry};

/// File browser for Docker containers via `docker exec`.
///
/// Created during [`Docker::connect()`](super::Docker) and stored for
/// the lifetime of the connection. Operations run commands inside the
/// container using bollard's exec API.
pub(crate) struct DockerFileBrowser {
    client: bollard::Docker,
    container_id: String,
}

impl DockerFileBrowser {
    pub(crate) fn new(client: bollard::Docker, container_id: String) -> Self {
        Self {
            client,
            container_id,
        }
    }
}

/// Environment prefix that pins a stable machine locale for every command run
/// inside the container.
///
/// bollard runs `cmd` as a bare argv (no shell is involved), so the locale is
/// forced by exec'ing through `env`. Pinning `LC_ALL=C LANG=C` keeps every
/// parsed command locale-invariant regardless of the container's `$LANG`:
///
/// * `stat`'s `%F` file-type text stays English (`directory` / `symbolic link`)
///   instead of a localized `Verzeichnis` / `répertoire` / `目录`, so the
///   directory/symlink detection in [`parse_stat_output`] keeps working
///   (I18N-003);
/// * `find`'s `%T@` epoch uses a `.` decimal separator instead of a locale
///   comma (`1700000000,5`) that would fail the `f64` parse and reset every
///   mtime to 1970 (I18N-004);
/// * command error text (`No such file`, `Permission denied`) stays English so
///   [`map_docker_error`] classifies it into the right [`FileError`] variant.
///
/// Every command this browser runs is a machine-parsed helper (`find`, `stat`,
/// `base64`, `rm`, `mv`, `mkdir`) — none is an interactive shell shown verbatim
/// to the user — so forcing the locale here is always safe.
const C_LOCALE_PREFIX: [&str; 3] = ["env", "LC_ALL=C", "LANG=C"];

/// Prepend the [`C_LOCALE_PREFIX`] to a command's argv so it runs under a
/// stable machine locale (see the constant's docs for why).
fn with_c_locale(cmd: Vec<&str>) -> Vec<&str> {
    let mut prefixed = Vec::with_capacity(cmd.len() + C_LOCALE_PREFIX.len());
    prefixed.extend_from_slice(&C_LOCALE_PREFIX);
    prefixed.extend(cmd);
    prefixed
}

/// Portable directory-listing shell script run once per `list_dir`, replacing
/// the GNU-only `find -printf` (CORE-012).
///
/// `find -printf` is a GNU findutils extension that BusyBox `find` — the `find`
/// in Alpine and most minimal container images — does not implement, so the old
/// command failed on exactly the most common base images. This script instead
/// derives every field with tools BusyBox and GNU coreutils both provide:
///
/// * `find` only *enumerates* the entries (both `find`s support `-maxdepth`,
///   `!`, and `-exec … +`); the script computes the metadata.
/// * `stat -c '%s %Y %a'` yields size / mtime-epoch / octal-mode — the same
///   specifiers the single-file [`FileBrowser::stat`] command already relies on
///   BusyBox supporting.
/// * `[ -L ]` / `readlink` detect a symlink and read its target; `[ -d ]`
///   (which follows symlinks) decides the *followed* type, so a symlink-to-dir
///   still lists as a directory.
///
/// It emits the **same tab-separated 7-field record** the previous `-printf`
/// format did — `name\town-type\tsize\tmtime\tmode\tfollowed-type\ttarget` —
/// so [`parse_find_output`] is unchanged. `name` is first (so a leading tab in
/// a name would split it, matching the old behavior) and `target` is the
/// rest-of-line final field (so a target may itself contain tabs). Records are
/// newline-separated, the same delimiter the old format used — a filename
/// containing a literal newline was, and remains, out of scope.
///
/// The per-entry `stat` is guarded: an entry that vanishes between the `find`
/// enumeration and the `stat` (a TOCTOU race) is skipped rather than emitted
/// with zeroed fields.
const LIST_DIR_SCRIPT: &str = r#"for f in "$@"; do
  name=${f##*/}
  meta=$(stat -c '%s %Y %a' "$f" 2>/dev/null) || continue
  [ -n "$meta" ] || continue
  if [ -L "$f" ]; then y=l; t=$(readlink "$f" 2>/dev/null); else y=f; t=; fi
  if [ -d "$f" ]; then yy=d; else yy=f; fi
  set -- $meta
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$y" "$1" "$2" "$3" "$yy" "$t"
done"#;

/// Build the portable `list_dir` command argv (CORE-012).
///
/// `find` enumerates the direct children of `path` (excluding the directory
/// itself) and hands them to the portable [`LIST_DIR_SCRIPT`] via
/// `-exec sh -c '…' sh {} +`. `!` (POSIX) is used instead of GNU `-not`.
fn list_dir_argv(path: &str) -> Vec<&str> {
    vec![
        "find",
        path,
        "-maxdepth",
        "1",
        "!",
        "-name",
        ".",
        "!",
        "-path",
        path,
        "-exec",
        "sh",
        "-c",
        LIST_DIR_SCRIPT,
        "sh",
        "{}",
        "+",
    ]
}

/// Run a command inside the container and return stdout as a string.
async fn exec_command(
    client: &bollard::Docker,
    container_id: &str,
    cmd: Vec<&str>,
) -> Result<String, FileError> {
    let cmd = with_c_locale(cmd);
    let exec_config = CreateExecOptions {
        attach_stdout: Some(true),
        attach_stderr: Some(true),
        cmd: Some(cmd),
        ..Default::default()
    };

    let exec = client
        .create_exec(container_id, exec_config)
        .await
        .map_err(|e| FileError::OperationFailed(format!("Failed to create exec: {e}")))?;

    let start_config = StartExecOptions {
        detach: false,
        ..Default::default()
    };

    let result = client
        .start_exec(&exec.id, Some(start_config))
        .await
        .map_err(|e| FileError::OperationFailed(format!("Failed to start exec: {e}")))?;

    match result {
        StartExecResults::Attached { mut output, .. } => {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            while let Some(chunk) = output.next().await {
                match chunk {
                    Ok(bollard::container::LogOutput::StdOut { message }) => {
                        stdout.extend_from_slice(&message);
                    }
                    Ok(bollard::container::LogOutput::StdErr { message }) => {
                        stderr.extend_from_slice(&message);
                    }
                    Ok(_) => {}
                    Err(e) => {
                        return Err(FileError::OperationFailed(format!(
                            "Exec output error: {e}"
                        )));
                    }
                }
            }

            // Check exec exit code to detect errors. A failed inspect is
            // propagated rather than swallowed (CORE-010): treating an unknown
            // result as success would report a failed command with empty/partial
            // stdout as OK — silent data corruption for file operations.
            let inspect = client
                .inspect_exec(&exec.id)
                .await
                .map_err(|e| FileError::OperationFailed(format!("Failed to inspect exec: {e}")))?;
            check_exec_exit_code(inspect.exit_code, &stderr)?;

            Ok(String::from_utf8_lossy(&stdout).to_string())
        }
        StartExecResults::Detached => Err(FileError::OperationFailed(
            "Exec started in detached mode".to_string(),
        )),
    }
}

/// Run a command inside the container with stdin data.
async fn exec_command_stdin(
    client: &bollard::Docker,
    container_id: &str,
    cmd: Vec<&str>,
    stdin_data: &[u8],
) -> Result<(), FileError> {
    let cmd = with_c_locale(cmd);
    let exec_config = CreateExecOptions {
        attach_stdin: Some(true),
        attach_stdout: Some(true),
        attach_stderr: Some(true),
        cmd: Some(cmd),
        ..Default::default()
    };

    let exec = client
        .create_exec(container_id, exec_config)
        .await
        .map_err(|e| FileError::OperationFailed(format!("Failed to create exec: {e}")))?;

    let start_config = StartExecOptions {
        detach: false,
        ..Default::default()
    };

    let result = client
        .start_exec(&exec.id, Some(start_config))
        .await
        .map_err(|e| FileError::OperationFailed(format!("Failed to start exec: {e}")))?;

    match result {
        StartExecResults::Attached {
            mut output, input, ..
        } => {
            // Write stdin data.
            let mut input = input;
            input
                .write_all(stdin_data)
                .await
                .map_err(|e| FileError::OperationFailed(format!("Failed to write stdin: {e}")))?;
            input
                .shutdown()
                .await
                .map_err(|e| FileError::OperationFailed(format!("Failed to close stdin: {e}")))?;

            // Drain output and collect stderr for error reporting.
            let mut stderr = Vec::new();
            while let Some(chunk) = output.next().await {
                match chunk {
                    Ok(bollard::container::LogOutput::StdErr { message }) => {
                        stderr.extend_from_slice(&message);
                    }
                    Ok(_) => {}
                    Err(e) => {
                        return Err(FileError::OperationFailed(format!(
                            "Exec output error: {e}"
                        )));
                    }
                }
            }

            // Propagate a failed inspect and treat an unknown exit code as a
            // failure (CORE-010) — a silently-dropped write must never look done.
            let inspect = client
                .inspect_exec(&exec.id)
                .await
                .map_err(|e| FileError::OperationFailed(format!("Failed to inspect exec: {e}")))?;
            check_exec_exit_code(inspect.exit_code, &stderr)?;

            Ok(())
        }
        StartExecResults::Detached => Err(FileError::OperationFailed(
            "Exec started in detached mode".to_string(),
        )),
    }
}

#[async_trait::async_trait]
impl FileBrowser for DockerFileBrowser {
    async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, FileError> {
        let output = exec_command(&self.client, &self.container_id, list_dir_argv(path)).await?;
        parse_find_output(&output, path)
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, FileError> {
        // Reject an oversized file before streaming its base64 into memory
        // (CORE-013): the `base64` exec accumulates the whole (~1.33x) stream plus
        // the decoded buffer, so a multi-GB / hostile file would OOM the app.
        // `stat` first and reject cleanly above the shared cap.
        let meta = self.stat(path).await?;
        crate::files::check_read_size(meta.size)?;

        let output = exec_command(&self.client, &self.container_id, vec!["base64", path]).await?;

        // `base64` wraps its output at 76 columns, so strip whitespace before
        // decoding with the strict STANDARD engine (which, unlike the old
        // hand-rolled reader, surfaces a decode error on a non-alphabet byte
        // instead of silently dropping it — LIBBE-001).
        let cleaned: String = output.chars().filter(|c| !c.is_whitespace()).collect();
        let data = base64::engine::general_purpose::STANDARD
            .decode(cleaned.as_bytes())
            .map_err(|e| FileError::OperationFailed(format!("base64 decode failed: {e}")))?;
        Ok(data)
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), FileError> {
        let encoded = base64::engine::general_purpose::STANDARD.encode(data);
        let script = format!("base64 -d > '{}'", shell_escape(path));
        exec_command_stdin(
            &self.client,
            &self.container_id,
            vec!["sh", "-c", &script],
            encoded.as_bytes(),
        )
        .await
    }

    async fn delete(&self, path: &str) -> Result<(), FileError> {
        // Stat to determine if it's a directory.
        let stat = self.stat(path).await?;
        if stat.is_directory {
            exec_command(&self.client, &self.container_id, vec!["rm", "-rf", path]).await?;
        } else {
            exec_command(&self.client, &self.container_id, vec!["rm", path]).await?;
        }
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), FileError> {
        exec_command(&self.client, &self.container_id, vec!["mv", from, to]).await?;
        Ok(())
    }

    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        let output = exec_command(
            &self.client,
            &self.container_id,
            vec!["stat", "-c", "%n\t%F\t%s\t%Y\t%a", path],
        )
        .await?;
        parse_stat_output(&output, path)
    }

    async fn mkdir(&self, path: &str) -> Result<(), FileError> {
        exec_command(&self.client, &self.container_id, vec!["mkdir", "-p", path]).await?;
        Ok(())
    }

    /// Docker file browsing is byte-based (no SFTP `setstat`), so chmod is not
    /// exposed here; the UI hides the action for byte-based sessions.
    async fn set_permissions(&self, _path: &str, _mode: u32) -> Result<(), FileError> {
        Err(FileError::NotSupported)
    }
}

// --- Parsing helpers (ported from agent/src/files/docker.rs) ---

/// Parse a listing record's mtime epoch-seconds value into whole seconds.
///
/// [`LIST_DIR_SCRIPT`] sources the mtime from `stat -c '%Y'` (already whole
/// integer seconds), but this stays defensive against a fractional value with a
/// locale comma (e.g. `1700000000,5` — as the retired `find -printf '%T@'` could
/// emit under a comma-decimal locale) so a stray localized value can never
/// silently reset the mtime to 1970 the way a bare `f64::from_str` would
/// (I18N-004). The fractional part is discarded — the browser reports
/// whole-second mtimes.
fn parse_epoch_seconds(field: &str) -> u64 {
    field.replace(',', ".").parse::<f64>().unwrap_or(0.0) as u64
}

/// Parse the tab-separated listing records emitted by [`LIST_DIR_SCRIPT`]:
/// `name\town-type\tsize\tmtime-epoch\tmode\tfollowed-type\ttarget` (CORE-012).
///
/// This is the same 7-field layout the retired GNU `find -printf
/// '%f\t%y\t%s\t%T@\t%m\t%Y\t%l\n'` produced, so the parser is shared. The
/// followed-type field (type after following links) and the target field let
/// the browser distinguish symlinks from the own-type field and report the link
/// target, matching the FTP/local behavior (#1513, #1523). The portable script
/// emits whole-second mtimes (no fractional part), but the parse stays robust to
/// a fractional/comma-decimal value for defence-in-depth (I18N-004).
fn parse_find_output(output: &str, parent_path: &str) -> Result<Vec<FileEntry>, FileError> {
    let mut entries = Vec::new();
    let parent = if parent_path.ends_with('/') {
        parent_path.to_string()
    } else {
        format!("{parent_path}/")
    };

    for line in output.lines() {
        if line.is_empty() {
            continue;
        }
        // The final `%l` field is empty for non-links, so a non-symlink row ends
        // in a trailing tab; `splitn(7, …)` still yields 7 fields (last empty).
        let fields: Vec<&str> = line.splitn(7, '\t').collect();
        if fields.len() < 7 {
            continue;
        }

        let name = fields[0].to_string();
        let own_type = fields[1];
        let size: u64 = fields[2].parse().unwrap_or(0);
        let mtime_secs = parse_epoch_seconds(fields[3]);
        let mode: u32 = u32::from_str_radix(fields[4].trim(), 8).unwrap_or(0);
        // `%Y` follows the link, so a symlink-to-dir still lists as a directory
        // (matching the local browser); it falls back to the own type otherwise.
        let is_directory = fields[5] == "d";
        // `%y` reports the entry's own type; `l` marks a symbolic link.
        let is_symlink = own_type == "l";
        // `%l` carries the target only for links; map the empty non-link value
        // (and a link whose target could not be read) to `None`.
        let symlink_target = if is_symlink {
            let target = fields[6];
            (!target.is_empty()).then(|| target.to_string())
        } else {
            None
        };

        let path = format!("{parent}{name}");
        let modified = chrono_from_epoch(mtime_secs);
        let permissions = Some(format_permissions(mode));

        entries.push(FileEntry {
            name,
            path,
            is_directory,
            size,
            modified,
            permissions,
            // Writability is derived only for the desktop SFTP browser (#1324).
            writable: None,
            is_symlink,
            symlink_target,
        });
    }

    Ok(entries)
}

/// Parse `stat -c '%n\t%F\t%s\t%Y\t%a'` output for a single file.
fn parse_stat_output(output: &str, path: &str) -> Result<FileEntry, FileError> {
    let line = output.trim();
    let fields: Vec<&str> = line.splitn(5, '\t').collect();
    if fields.len() < 5 {
        return Err(FileError::OperationFailed(format!(
            "Unexpected stat output: {line}"
        )));
    }

    let name = std::path::Path::new(fields[0])
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| fields[0].to_string());
    let file_type = fields[1];
    let is_directory = file_type.contains("directory");
    let size: u64 = fields[2].parse().unwrap_or(0);
    let mtime: u64 = fields[3].parse().unwrap_or(0);
    let mode: u32 = u32::from_str_radix(fields[4].trim(), 8).unwrap_or(0);

    Ok(FileEntry {
        name,
        path: path.to_string(),
        is_directory,
        size,
        modified: chrono_from_epoch(mtime),
        permissions: Some(format_permissions(mode)),
        // Writability is derived only for the desktop SFTP browser (#1324).
        writable: None,
        // `stat` does not dereference by default, so `%F` reports "symbolic
        // link" for a link itself; the target is not carried by this capture.
        is_symlink: file_type.contains("symbolic link"),
        symlink_target: None,
    })
}

/// Map a finished `docker exec`'s inspected exit code to a result (CORE-010).
///
/// bollard reports the exit code as `Option<i64>`: `Some(code)` once the exec
/// has finished, `None` if it could not be determined (e.g. still running or an
/// incomplete inspect response). Only an explicit `Some(0)` is success — a
/// non-zero code **and** an absent code both map to a `FileError`, so a command
/// that actually failed can never be reported as OK with empty/partial output.
///
/// When `stderr` carries a message it is classified via [`map_docker_error`]
/// (preserving NotFound / PermissionDenied); otherwise a concrete
/// [`FileError::OperationFailed`] is synthesized from the exit code.
fn check_exec_exit_code(exit_code: Option<i64>, stderr: &[u8]) -> Result<(), FileError> {
    if exit_code == Some(0) {
        return Ok(());
    }
    let stderr_str = String::from_utf8_lossy(stderr);
    if stderr_str.trim().is_empty() {
        Err(FileError::OperationFailed(match exit_code {
            Some(code) => format!("container command exited with status {code}"),
            None => "container command exit code unavailable".to_string(),
        }))
    } else {
        Err(map_docker_error(&stderr_str))
    }
}

/// Map docker exec stderr to appropriate `FileError`.
fn map_docker_error(stderr: &str) -> FileError {
    let lower = stderr.to_lowercase();
    if lower.contains("no such file") || lower.contains("not found") {
        FileError::NotFound(stderr.trim().to_string())
    } else if lower.contains("permission denied") {
        FileError::PermissionDenied(stderr.trim().to_string())
    } else {
        FileError::OperationFailed(stderr.trim().to_string())
    }
}

/// Simple shell escaping for single-quoted strings.
fn shell_escape(s: &str) -> String {
    s.replace('\'', "'\\''")
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- parse_find_output tests ---

    #[test]
    fn parse_find_output_basic() {
        // Columns: %f %y %s %T@ %m %Y %l — a plain file/dir has an empty %l
        // (trailing tab) and %Y == %y.
        let output = "readme.md\tf\t1024\t1705321845.0\t644\tf\t\n\
                       src\td\t4096\t1705321845.0\t755\td\t\n";
        let entries = parse_find_output(output, "/project").unwrap();
        assert_eq!(entries.len(), 2);

        let file = &entries[0];
        assert_eq!(file.name, "readme.md");
        assert_eq!(file.path, "/project/readme.md");
        assert!(!file.is_directory);
        assert_eq!(file.size, 1024);
        assert_eq!(file.permissions.as_deref(), Some("rw-r--r--"));
        assert!(!file.is_symlink);
        assert_eq!(file.symlink_target, None);

        let dir = &entries[1];
        assert_eq!(dir.name, "src");
        assert!(dir.is_directory);
        assert_eq!(dir.permissions.as_deref(), Some("rwxr-xr-x"));
        assert!(!dir.is_symlink);
    }

    #[test]
    fn parse_find_output_empty() {
        let entries = parse_find_output("", "/empty").unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn parse_find_output_survives_comma_decimal_mtime() {
        // Regression for I18N-004: under a comma-decimal container locale
        // `find`'s `%T@` is emitted as e.g. `1700000000,5`. A bare `f64` parse
        // rejects the comma and resets the mtime to the 1970 epoch. The robust
        // parse recovers the real timestamp (defence-in-depth on top of the
        // forced C locale that keeps the separator a `.`).
        let output = "file.txt\tf\t100\t1700000000,5\t644\tf\t\n";
        let entries = parse_find_output(output, "/dir").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].modified, "2023-11-14T22:13:20Z",
            "a comma-decimal mtime must not collapse to 1970"
        );
    }

    #[test]
    fn parse_epoch_seconds_accepts_dot_and_comma_decimals() {
        // The C-locale form (`.`) and a stray localized comma both resolve to
        // the same whole-second epoch; only genuine garbage falls back to 0.
        assert_eq!(parse_epoch_seconds("1700000000.5"), 1_700_000_000);
        assert_eq!(parse_epoch_seconds("1700000000,5"), 1_700_000_000);
        assert_eq!(parse_epoch_seconds("1700000000"), 1_700_000_000);
        assert_eq!(parse_epoch_seconds("not-a-number"), 0);
    }

    // --- C-locale forcing (I18N-003/004/005) ---

    #[test]
    fn with_c_locale_prepends_env_prefix() {
        // Every parsed docker command must run under a forced C locale so its
        // output (stat's `%F` text, find's `%T@` decimal) and its error text
        // stay locale-invariant regardless of the container's `$LANG`.
        let cmd = with_c_locale(vec!["stat", "-c", "%n\t%F\t%s\t%Y\t%a", "/etc"]);
        assert_eq!(
            &cmd[..3],
            &["env", "LC_ALL=C", "LANG=C"],
            "command must be exec'd through `env LC_ALL=C LANG=C`"
        );
        assert_eq!(
            &cmd[3..],
            &["stat", "-c", "%n\t%F\t%s\t%Y\t%a", "/etc"],
            "the original command must follow the locale prefix unchanged"
        );
    }

    #[test]
    fn parse_find_output_trailing_slash() {
        let output = "file.txt\tf\t100\t1000000.0\t644\tf\t\n";
        let entries = parse_find_output(output, "/dir/").unwrap();
        assert_eq!(entries[0].path, "/dir/file.txt");
    }

    #[test]
    fn parse_find_output_symlink_with_target() {
        // A symlink: own type %y == `l`, followed type %Y resolves to the target
        // kind, and %l carries the link target.
        let output = "link\tl\t7\t1705321845.0\t777\tf\t/etc/target\n";
        let entries = parse_find_output(output, "/project").unwrap();
        assert_eq!(entries.len(), 1);

        let link = &entries[0];
        assert_eq!(link.name, "link");
        assert!(link.is_symlink, "is_symlink");
        assert_eq!(link.symlink_target.as_deref(), Some("/etc/target"));
        // %Y == `f` (target is a regular file), so it does not list as a dir.
        assert!(!link.is_directory);
    }

    #[test]
    fn parse_find_output_symlink_to_directory_lists_as_dir() {
        // A symlink-to-dir: %y == `l` but %Y == `d`, so it stays navigable as a
        // directory while still being flagged a symlink.
        let output = "linkdir\tl\t7\t1705321845.0\t777\td\t/var/data\n";
        let entries = parse_find_output(output, "/project").unwrap();
        let link = &entries[0];
        assert!(link.is_symlink);
        assert!(
            link.is_directory,
            "symlink-to-dir should list as a directory"
        );
        assert_eq!(link.symlink_target.as_deref(), Some("/var/data"));
    }

    #[test]
    fn parse_find_output_broken_symlink_has_no_target() {
        // A symlink whose target find could not resolve: %l may still carry the
        // raw target, but an empty %l maps to None rather than an empty string.
        let output = "broken\tl\t7\t1705321845.0\t777\tN\t\n";
        let entries = parse_find_output(output, "/project").unwrap();
        let link = &entries[0];
        assert!(link.is_symlink);
        assert_eq!(link.symlink_target, None);
    }

    // --- list_dir portability (CORE-012) ---

    #[test]
    fn list_dir_argv_is_busybox_portable() {
        // The command must not use the GNU-only `find -printf` (unsupported by
        // BusyBox `find`, which is what Alpine and most minimal images ship), and
        // must use the POSIX `!` negation rather than GNU `-not`.
        let argv = list_dir_argv("/project");
        assert!(
            !argv.contains(&"-printf"),
            "must not use the GNU-only -printf: {argv:?}"
        );
        assert!(
            !argv.contains(&"-not"),
            "must use POSIX `!`, not GNU `-not`: {argv:?}"
        );
        assert!(argv.contains(&"!"), "expected POSIX negation operator");
        assert!(
            argv.contains(&"-maxdepth"),
            "expected -maxdepth enumeration"
        );
        // Metadata is derived with tools BusyBox and coreutils both provide.
        assert!(argv.contains(&LIST_DIR_SCRIPT));
        assert!(LIST_DIR_SCRIPT.contains("stat -c"));
        assert!(LIST_DIR_SCRIPT.contains("readlink"));
        // `-exec … +` batches the entries into the portable helper.
        assert_eq!(argv.last(), Some(&"+"));
    }

    #[test]
    fn parse_find_output_portable_script_sample() {
        // Representative output of LIST_DIR_SCRIPT. Because the script derives
        // every field with portable tools (`stat -c '%s %Y %a'`, `readlink`,
        // `[ -L ]`, `[ -d ]`), its output is byte-identical whether the container
        // ships GNU coreutils or BusyBox — there is a single portable form, not a
        // GNU form and a BusyBox form. Fields:
        //   name  own-type  size  mtime  mode  followed-type  target
        // Note a non-symlink (including a directory) has own-type `f`; a
        // directory is identified by the followed-type `d`.
        let output = "my file.txt\tf\t1024\t1705321845\t644\tf\t\n\
                       src\tf\t4096\t1705321845\t755\td\t\n\
                       link\tl\t7\t1705321845\t777\tf\t/etc/target\n\
                       linkdir\tl\t7\t1705321845\t777\td\t/var/data\n\
                       broken\tl\t7\t1705321845\t777\tf\t/missing\n";
        let entries = parse_find_output(output, "/project").unwrap();
        assert_eq!(entries.len(), 5);

        // Regular file with a space in the name.
        let file = &entries[0];
        assert_eq!(file.name, "my file.txt");
        assert_eq!(file.path, "/project/my file.txt");
        assert!(!file.is_directory);
        assert!(!file.is_symlink);
        assert_eq!(file.size, 1024);
        assert_eq!(file.modified, "2024-01-15T12:30:45Z");
        assert_eq!(file.permissions.as_deref(), Some("rw-r--r--"));

        // Plain directory: own-type `f`, followed-type `d`.
        let dir = &entries[1];
        assert_eq!(dir.name, "src");
        assert!(dir.is_directory);
        assert!(!dir.is_symlink);
        assert_eq!(dir.permissions.as_deref(), Some("rwxr-xr-x"));

        // Symlink to a file.
        let link = &entries[2];
        assert_eq!(link.name, "link");
        assert!(link.is_symlink);
        assert!(!link.is_directory);
        assert_eq!(link.symlink_target.as_deref(), Some("/etc/target"));

        // Symlink to a directory still lists as a navigable directory.
        let linkdir = &entries[3];
        assert!(linkdir.is_symlink);
        assert!(linkdir.is_directory);
        assert_eq!(linkdir.symlink_target.as_deref(), Some("/var/data"));

        // Broken symlink: readlink still reports the (dangling) target; the
        // followed-type falls back to `f`, so it does not list as a directory.
        let broken = &entries[4];
        assert!(broken.is_symlink);
        assert!(!broken.is_directory);
        assert_eq!(broken.symlink_target.as_deref(), Some("/missing"));
    }

    // --- parse_stat_output tests ---

    #[test]
    fn parse_stat_output_file() {
        let output = "/project/readme.md\tregular file\t1024\t1705321845\t644\n";
        let result = parse_stat_output(output, "/project/readme.md").unwrap();
        assert_eq!(result.name, "readme.md");
        assert!(!result.is_directory);
        assert_eq!(result.size, 1024);
        assert_eq!(result.permissions.as_deref(), Some("rw-r--r--"));
    }

    #[test]
    fn parse_stat_output_directory() {
        let output = "/var/log\tdirectory\t4096\t1705321845\t755\n";
        let result = parse_stat_output(output, "/var/log").unwrap();
        assert_eq!(result.name, "log");
        assert!(result.is_directory);
        assert_eq!(result.permissions.as_deref(), Some("rwxr-xr-x"));
        assert!(!result.is_symlink);
    }

    #[test]
    fn parse_stat_output_symlink() {
        // `stat -c %F` reports "symbolic link" for a link without dereferencing.
        let output = "/project/link\tsymbolic link\t7\t1705321845\t777\n";
        let result = parse_stat_output(output, "/project/link").unwrap();
        assert_eq!(result.name, "link");
        assert!(result.is_symlink, "is_symlink");
        assert!(!result.is_directory);
    }

    #[test]
    fn parse_stat_output_invalid() {
        let result = parse_stat_output("bad output", "/foo");
        assert!(result.is_err());
    }

    // --- shell_escape tests ---

    #[test]
    fn shell_escape_basic() {
        assert_eq!(shell_escape("hello"), "hello");
        assert_eq!(shell_escape("it's"), "it'\\''s");
    }

    // --- map_docker_error tests ---

    #[test]
    fn map_docker_error_not_found() {
        let err = map_docker_error("stat: cannot stat '/foo': No such file or directory");
        assert!(matches!(err, FileError::NotFound(_)));
    }

    #[test]
    fn map_docker_error_permission_denied() {
        let err = map_docker_error("cat: /etc/shadow: Permission denied");
        assert!(matches!(err, FileError::PermissionDenied(_)));
    }

    #[test]
    fn map_docker_error_generic() {
        let err = map_docker_error("something went wrong");
        assert!(matches!(err, FileError::OperationFailed(_)));
    }

    // --- check_exec_exit_code tests (CORE-010) ---

    #[test]
    fn check_exec_exit_code_zero_is_success() {
        assert!(check_exec_exit_code(Some(0), b"").is_ok());
        // A zero exit is success even if the command wrote to stderr (warnings).
        assert!(check_exec_exit_code(Some(0), b"some warning").is_ok());
    }

    #[test]
    fn check_exec_exit_code_nonzero_maps_stderr() {
        let err = check_exec_exit_code(Some(1), b"rm: cannot remove: No such file or directory");
        assert!(matches!(err, Err(FileError::NotFound(_))));

        let err = check_exec_exit_code(Some(1), b"cat: /etc/shadow: Permission denied");
        assert!(matches!(err, Err(FileError::PermissionDenied(_))));
    }

    #[test]
    fn check_exec_exit_code_nonzero_without_stderr_reports_status() {
        // A non-zero exit with no stderr must still be an error carrying the code.
        match check_exec_exit_code(Some(2), b"") {
            Err(FileError::OperationFailed(msg)) => assert!(msg.contains('2'), "msg: {msg}"),
            other => panic!("expected OperationFailed with status, got {other:?}"),
        }
    }

    #[test]
    fn check_exec_exit_code_none_is_failure_not_success() {
        // Regression for CORE-010: an unknown exit code (failed/absent inspect)
        // was previously `unwrap_or(0)`-ed into success, silently reporting a
        // failed command as OK. It must now be treated as a failure.
        assert!(check_exec_exit_code(None, b"").is_err());
        // With stderr present, the message is still classified.
        let err = check_exec_exit_code(None, b"stat: No such file");
        assert!(matches!(err, Err(FileError::NotFound(_))));
    }

    // --- base64 tests (LIBBE-001: now over the `base64` crate) ---

    /// Encode via the same STANDARD engine the browser now uses on the write
    /// path, mirroring `write_file`.
    fn b64_encode(data: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(data)
    }

    /// Decode the way `read_file` does: strip the whitespace `base64` inserts to
    /// wrap its output, then decode strictly.
    fn b64_decode(input: &str) -> Result<Vec<u8>, base64::DecodeError> {
        let cleaned: String = input.chars().filter(|c| !c.is_whitespace()).collect();
        base64::engine::general_purpose::STANDARD.decode(cleaned.as_bytes())
    }

    #[test]
    fn base64_encode_empty() {
        assert_eq!(b64_encode(b""), "");
    }

    #[test]
    fn base64_encode_hello_matches_known_vector() {
        // RFC 4648 / canonical vector — the crate must produce standard base64.
        assert_eq!(b64_encode(b"Hello, World!"), "SGVsbG8sIFdvcmxkIQ==");
    }

    #[test]
    fn base64_decode_known_vector() {
        assert_eq!(
            b64_decode("SGVsbG8sIFdvcmxkIQ==").unwrap(),
            b"Hello, World!"
        );
    }

    #[test]
    fn base64_roundtrip() {
        let data = b"The quick brown fox jumps over the lazy dog";
        let encoded = b64_encode(data);
        assert_eq!(b64_decode(&encoded).unwrap(), data);
    }

    #[test]
    fn base64_roundtrip_binary() {
        // All 256 byte values, exercising the padding edge cases at every input
        // length modulo 3 (256 % 3 == 1, so this ends in a two-`=` group).
        let data: Vec<u8> = (0..=255).collect();
        let encoded = b64_encode(&data);
        assert_eq!(b64_decode(&encoded).unwrap(), data);
    }

    #[test]
    fn base64_roundtrip_padding_lengths() {
        // 1/2/3-byte inputs cover the `==`, `=`, and no-padding tail cases.
        for data in [b"f".as_slice(), b"fo", b"foo", b"foob", b"fooba", b"foobar"] {
            let encoded = b64_encode(data);
            assert_eq!(
                b64_decode(&encoded).unwrap(),
                data,
                "roundtrip for {data:?}"
            );
        }
    }

    #[test]
    fn base64_decode_tolerates_wrapped_whitespace() {
        // `base64` wraps output at 76 columns; the read path strips whitespace
        // (spaces and newlines) before decoding.
        let wrapped = "SGVsbG8s\nIFdvcmxk\nIQ==\n";
        assert_eq!(b64_decode(wrapped).unwrap(), b"Hello, World!");
    }

    #[test]
    fn base64_decode_rejects_non_alphabet_byte() {
        // Regression for LIBBE-001: the old hand-rolled reader silently dropped
        // any byte outside the alphabet, so corruption in the exec output passed
        // through as "successfully decoded". The strict crate surfaces an error.
        //
        // `*` is not whitespace (so it survives the strip) and is not a base64
        // alphabet character, so it must produce a decode error.
        assert!(b64_decode("SGVs*bG8=").is_err());
    }
}

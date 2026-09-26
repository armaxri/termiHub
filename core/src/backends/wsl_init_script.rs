//! Platform-independent helpers for creating the WSL shell-integration init
//! script **inside the distribution** with mode `0600` (#2837, follow-up to
//! CORE-019).
//!
//! The WSL backend itself is Windows-only, but everything security-relevant
//! about how the init script is created lives here as pure functions so it is
//! unit-tested on every platform:
//!
//! - [`CREATE_INIT_SCRIPT_SH`] — the POSIX `sh` program run inside the distro
//!   (via `wsl.exe --exec sh -c …`). It sets `umask 077` so the file is born
//!   `0600`, refuses a pre-existing path or symlink, and creates the file with
//!   `noclobber` (`O_EXCL`) semantics. The script *content* arrives on stdin,
//!   never on a command line.
//! - [`is_safe_init_path`] / [`distro_create_args`] — the only variable part of
//!   the command line is the tool-generated path, which is validated against a
//!   strict character set and passed as a positional argument (`"$1"`), never
//!   interpolated into the program text.
//! - [`init_script_contents`] / [`source_line`] — the script body (ending in its
//!   `rm -f` self-cleanup) and the line injected into the PTY to source it.
//! - [`choose_delivery`] — the fallback decision: distro-side `0600` create,
//!   then the legacy Windows-side UNC `create_new` write, then visible direct
//!   injection.
//!
//! Only the thin I/O shell that actually spawns `wsl.exe` / opens the UNC path
//! lives in the `#[cfg(windows)]` `wsl` module.

/// Prefix of every per-session init-script path (see `init_script_linux_path`
/// in the `wsl` backend, which appends a v4 UUID).
pub(crate) const INIT_SCRIPT_PATH_PREFIX: &str = "/tmp/.termihub_init-";

/// POSIX `sh` program that creates the init script inside the distribution.
///
/// Invoked as `sh -c CREATE_INIT_SCRIPT_SH sh <path>` with the script content
/// on stdin:
///
/// - `umask 077` — the file is created with mode `0600` (owner read/write only)
///   from the very first byte, so there is no window where it is readable or
///   writable by another user.
/// - `set -C` (`noclobber`) — `>` refuses to overwrite an existing file; bash
///   and dash both open a non-existent target with `O_CREAT|O_EXCL`, which also
///   refuses a dangling symlink.
/// - The explicit `[ -e ] || [ -L ]` guard rejects *any* pre-existing entry —
///   including a symlink to a FIFO or device, which some shells' `noclobber`
///   would otherwise open — before the exclusive create is attempted.
/// - `cat > "$1"` — the content is read from stdin, never from argv, so it is
///   not visible in the process table.
pub(crate) const CREATE_INIT_SCRIPT_SH: &str =
    "umask 077 && set -C && if [ -e \"$1\" ] || [ -L \"$1\" ]; then exit 17; fi && cat > \"$1\"";

/// Return `true` when `path` is a tool-generated per-session init-script path.
///
/// Defense in depth for the command line: the path must be
/// [`INIT_SCRIPT_PATH_PREFIX`] followed by 1–64 characters from
/// `[0-9a-f-]` (a hyphenated lowercase v4 UUID). Anything else — whitespace,
/// quotes, `/`, `..`, shell metacharacters, uppercase — is rejected.
pub(crate) fn is_safe_init_path(path: &str) -> bool {
    match path.strip_prefix(INIT_SCRIPT_PATH_PREFIX) {
        Some(suffix) => {
            !suffix.is_empty()
                && suffix.len() <= 64
                && suffix
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
        }
        None => false,
    }
}

/// Build the `wsl.exe` argument vector that creates `path` inside
/// `distribution` with mode `0600`.
///
/// Uses `--exec` so the distro's login shell does **not** re-parse the command
/// line; `sh` receives [`CREATE_INIT_SCRIPT_SH`] verbatim as its `-c` program,
/// `sh` as `$0`, and `path` as `$1`. Returns `None` when `path` fails
/// [`is_safe_init_path`] (or the distribution name is empty), in which case the
/// caller must not attempt the distro-side create.
pub(crate) fn distro_create_args(distribution: &str, path: &str) -> Option<Vec<String>> {
    if distribution.is_empty() || !is_safe_init_path(path) {
        return None;
    }
    Some(super::wsl_exec::distro_sh_args(
        distribution,
        CREATE_INIT_SCRIPT_SH,
        &[path],
    ))
}

/// The init-script body: the setup command followed by the `rm -f` that
/// self-cleans the per-session file once it has been sourced.
pub(crate) fn init_script_contents(setup_cmd: &str, path: &str) -> String {
    format!("{setup_cmd}\nrm -f {path}\n")
}

/// The line injected into the PTY to source the init script. `2>/dev/null`
/// suppresses a "no such file" error should the file be missing.
pub(crate) fn source_line(path: &str) -> String {
    format!("source {path} 2>/dev/null\n")
}

/// How the setup command reaches the shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InitDelivery {
    /// The init script was created inside the distro with mode `0600`
    /// (preferred) — source it.
    SourceDistroFile,
    /// The distro-side create failed; the script was written Windows-side over
    /// the UNC path with `create_new` (O_EXCL, default 9p mode) — source it.
    SourceUncFile,
    /// Neither file could be created — inject the setup command directly
    /// (visible in the terminal, but CWD tracking still works).
    DirectInjection,
}

/// Decide how to deliver the setup command.
///
/// The distro-side `0600` create is always tried first. Only if it fails is
/// `try_unc` invoked (the legacy Windows-side `create_new` write, which keeps
/// the unpredictable name + O_EXCL but cannot set a unix mode). If that also
/// fails, fall back to direct injection. `try_unc` is lazy so the UNC write is
/// never attempted once the distro-side file exists.
pub(crate) fn choose_delivery(
    distro_created: bool,
    try_unc: impl FnOnce() -> bool,
) -> InitDelivery {
    if distro_created {
        InitDelivery::SourceDistroFile
    } else if try_unc() {
        InitDelivery::SourceUncFile
    } else {
        InitDelivery::DirectInjection
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UUID_PATH: &str = "/tmp/.termihub_init-3f2b8c1e-9d4a-4e7b-8c21-0a1b2c3d4e5f";

    #[test]
    fn safe_path_accepts_uuid_path() {
        assert!(is_safe_init_path(UUID_PATH));
    }

    #[test]
    fn safe_path_rejects_hostile_or_malformed_paths() {
        for bad in [
            "",
            "/tmp/.termihub_init",
            "/tmp/.termihub_init-",
            "/tmp/other-3f2b8c1e",
            "/tmp/.termihub_init-abc def",
            "/tmp/.termihub_init-abc;rm -rf ~",
            "/tmp/.termihub_init-abc\"x",
            "/tmp/.termihub_init-abc'x",
            "/tmp/.termihub_init-$(id)",
            "/tmp/.termihub_init-../../etc/passwd",
            "/tmp/.termihub_init-ABCDEF",
            "/tmp/.termihub_init-abc\n",
            "/tmp/.termihub_init-abc*",
        ] {
            assert!(!is_safe_init_path(bad), "should reject {bad:?}");
        }
        let too_long = format!("{INIT_SCRIPT_PATH_PREFIX}{}", "a".repeat(65));
        assert!(!is_safe_init_path(&too_long));
    }

    #[test]
    fn distro_args_use_exec_and_positional_path() {
        let args = distro_create_args("Ubuntu-22.04", UUID_PATH).expect("safe path");
        assert_eq!(
            args,
            vec![
                "-d",
                "Ubuntu-22.04",
                "--exec",
                "sh",
                "-c",
                CREATE_INIT_SCRIPT_SH,
                "sh",
                UUID_PATH,
            ]
        );
        // The path is never spliced into the program text.
        assert!(!CREATE_INIT_SCRIPT_SH.contains(UUID_PATH));
    }

    #[test]
    fn distro_args_reject_unsafe_path_or_empty_distro() {
        assert!(distro_create_args("Ubuntu", "/tmp/x;id").is_none());
        assert!(distro_create_args("", UUID_PATH).is_none());
    }

    #[test]
    fn create_program_sets_umask_noclobber_and_reads_stdin() {
        assert!(CREATE_INIT_SCRIPT_SH.starts_with("umask 077 && set -C"));
        assert!(CREATE_INIT_SCRIPT_SH.contains("[ -L \"$1\" ]"));
        assert!(CREATE_INIT_SCRIPT_SH.ends_with("cat > \"$1\""));
    }

    #[test]
    fn contents_end_with_self_cleanup_and_source_line_matches() {
        let body = init_script_contents("echo hook", UUID_PATH);
        assert_eq!(body, format!("echo hook\nrm -f {UUID_PATH}\n"));
        assert_eq!(
            source_line(UUID_PATH),
            format!("source {UUID_PATH} 2>/dev/null\n")
        );
    }

    #[test]
    fn delivery_prefers_distro_file_and_skips_unc() {
        let mut unc_called = false;
        let d = choose_delivery(true, || {
            unc_called = true;
            true
        });
        assert_eq!(d, InitDelivery::SourceDistroFile);
        assert!(
            !unc_called,
            "UNC write must not run once distro file exists"
        );
    }

    #[test]
    fn delivery_falls_back_to_unc_then_direct_injection() {
        assert_eq!(choose_delivery(false, || true), InitDelivery::SourceUncFile);
        assert_eq!(
            choose_delivery(false, || false),
            InitDelivery::DirectInjection
        );
    }

    /// Execute [`CREATE_INIT_SCRIPT_SH`] with the host's `sh` — the same program
    /// the distro runs — and verify the security properties for real.
    #[cfg(unix)]
    mod exec {
        use super::super::CREATE_INIT_SCRIPT_SH;
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        use std::path::Path;
        use std::process::{Command, Stdio};

        fn run_create(path: &Path, content: &[u8]) -> bool {
            let mut child = Command::new("sh")
                .args(["-c", CREATE_INIT_SCRIPT_SH, "sh"])
                .arg(path)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn sh");
            {
                let mut stdin = child.stdin.take().expect("stdin");
                // A rejected create may exit before reading stdin (EPIPE).
                let _ = stdin.write_all(content);
            }
            child.wait().expect("wait sh").success()
        }

        #[test]
        fn creates_file_with_mode_0600_and_exact_content() {
            let dir = tempfile::tempdir().expect("tempdir");
            let path = dir.path().join(".termihub_init-abc");
            assert!(run_create(&path, b"echo hook\nrm -f x\n"));
            let meta = std::fs::symlink_metadata(&path).expect("created");
            assert!(meta.file_type().is_file());
            assert_eq!(meta.permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::read(&path).expect("read"), b"echo hook\nrm -f x\n");
        }

        #[test]
        fn rejects_pre_existing_file_without_touching_it() {
            let dir = tempfile::tempdir().expect("tempdir");
            let path = dir.path().join(".termihub_init-abc");
            std::fs::write(&path, b"attacker").expect("seed");
            assert!(!run_create(&path, b"ours"));
            assert_eq!(std::fs::read(&path).expect("read"), b"attacker");
        }

        #[test]
        fn rejects_symlink_to_existing_file_without_following_it() {
            let dir = tempfile::tempdir().expect("tempdir");
            let target = dir.path().join("victim");
            std::fs::write(&target, b"victim").expect("seed");
            let path = dir.path().join(".termihub_init-abc");
            std::os::unix::fs::symlink(&target, &path).expect("symlink");
            assert!(!run_create(&path, b"ours"));
            assert_eq!(std::fs::read(&target).expect("read"), b"victim");
        }

        #[test]
        fn rejects_dangling_symlink_without_creating_target() {
            let dir = tempfile::tempdir().expect("tempdir");
            let target = dir.path().join("not-yet");
            let path = dir.path().join(".termihub_init-abc");
            std::os::unix::fs::symlink(&target, &path).expect("symlink");
            assert!(!run_create(&path, b"ours"));
            assert!(!target.exists(), "must not create through a symlink");
        }
    }
}

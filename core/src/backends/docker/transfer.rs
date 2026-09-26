//! Streaming `docker exec` primitives for the queued Docker transfer executor
//! ([`crate::files::transfer::docker`], PARITY-004 / #3567).
//!
//! The browsing path ([`DockerFileBrowser`](super::file_browser::DockerFileBrowser))
//! moves whole files as one base64 blob. A queued transfer instead streams the
//! raw bytes through a dedicated exec per attempt, with bounded memory:
//!
//! - **download**: `cat < "$1"` (fresh) or `tail -c "+N" < "$1"` (resume from
//!   byte `N-1`), stdout exposed as an [`AsyncRead`] ([`ExecReader`]);
//! - **upload**: `cat > "$1"` (fresh) or `cat >> "$1"` (append at the verified
//!   offset), stdin exposed as an [`AsyncWrite`] ([`ExecWriter`]);
//! - **fingerprint / present size**: `stat -c '%s %Y' -- PATH` and
//!   `wc -c < "$1"`.
//!
//! **No shell injection.** Every script is a fixed constant; the path (and the
//! offset) reach it only as positional arguments (`sh -c SCRIPT sh PATH N`) and
//! are always referenced quoted (`"$1"`), so no path byte is ever parsed as
//! shell syntax. Reading through a redirection also keeps a path that starts
//! with `-` from being parsed as an option.
//!
//! **Busybox vs coreutils.** All commands are POSIX and exist in both, but
//! minimal images can lack individual tools, so the executor probes the
//! container once per transfer ([`DockerTransferTarget::probe`]) and refuses
//! an offset resume — restarting from zero instead — whenever it cannot read
//! at an offset or fingerprint the source. A resume is never guessed.

use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use bollard::container::LogOutput;
use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use futures_util::{Stream, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};

use super::file_browser::{check_exec_exit_code, exec_command, with_c_locale, DockerFileBrowser};
use crate::errors::FileError;
use crate::files::transfer::SourceFingerprint;
use crate::files::FileBrowser;

/// Capability probe run once per transfer. Prints one token per usable tool:
/// `cat` (streaming at all), `tail` (read from an offset), `stat` (source
/// fingerprint), `wc` (destination size). Always exits `0`.
const PROBE_SCRIPT: &str = r#"command -v cat >/dev/null 2>&1 && echo cat
[ "$(printf abc | tail -c +2 2>/dev/null)" = bc ] && echo tail
[ -n "$(stat -c '%s %Y' / 2>/dev/null)" ] && echo stat
n=$(printf abc | wc -c 2>/dev/null) && [ $n -eq 3 ] 2>/dev/null && echo wc
exit 0"#;

/// Stream the whole file to stdout.
const READ_ALL_SCRIPT: &str = r#"exec cat < "$1""#;
/// Stream the file from 1-based byte `$2` (i.e. skip `$2 - 1` bytes).
const READ_FROM_SCRIPT: &str = r#"exec tail -c "+$2" < "$1""#;
/// Create/truncate the file from stdin.
const WRITE_SCRIPT: &str = r#"exec cat > "$1""#;
/// Append stdin to the existing file.
const APPEND_SCRIPT: &str = r#"exec cat >> "$1""#;
/// Print the file's size in bytes.
const SIZE_SCRIPT: &str = r#"exec wc -c < "$1""#;

/// Upper bound on the stderr kept per exec for error reporting.
const STDERR_CAP: usize = 16 * 1024;

/// How long to wait for the daemon to record an exec's exit after its stream
/// ended, before treating the exit code as unknown (a failure).
const EXIT_WAIT: Duration = Duration::from_secs(5);
const EXIT_POLL: Duration = Duration::from_millis(50);

/// Which streaming tools a container provides, from [`PROBE_SCRIPT`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ContainerCaps {
    /// `cat` — required for any streaming transfer.
    pub cat: bool,
    /// `tail -c +N` — required to resume a download from an offset.
    pub offset_read: bool,
    /// `stat -c '%s %Y'` — required to fingerprint a container-side source.
    pub stat: bool,
    /// `wc -c` — required to measure a container-side partial destination.
    pub size: bool,
}

impl ContainerCaps {
    /// Parse the [`PROBE_SCRIPT`] output (one token per line). Pure.
    pub fn parse(output: &str) -> Self {
        let mut caps = Self::default();
        for token in output.split_whitespace() {
            match token {
                "cat" => caps.cat = true,
                "tail" => caps.offset_read = true,
                "stat" => caps.stat = true,
                "wc" => caps.size = true,
                _ => {}
            }
        }
        caps
    }
}

/// Argv for streaming `path` from byte `offset` to stdout. Pure.
fn read_argv(path: &str, offset: u64) -> Vec<String> {
    if offset == 0 {
        vec![
            "sh".into(),
            "-c".into(),
            READ_ALL_SCRIPT.into(),
            "sh".into(),
            path.into(),
        ]
    } else {
        // `tail -c +N` is 1-based: `+N` starts at byte N, skipping N-1 bytes.
        vec![
            "sh".into(),
            "-c".into(),
            READ_FROM_SCRIPT.into(),
            "sh".into(),
            path.into(),
            offset.saturating_add(1).to_string(),
        ]
    }
}

/// Argv for writing stdin to `path` (append or create/truncate). Pure.
fn write_argv(path: &str, append: bool) -> Vec<String> {
    let script = if append { APPEND_SCRIPT } else { WRITE_SCRIPT };
    vec![
        "sh".into(),
        "-c".into(),
        script.into(),
        "sh".into(),
        path.into(),
    ]
}

/// Argv printing `path`'s size and mtime (epoch seconds). Pure.
fn fingerprint_argv(path: &str) -> Vec<String> {
    vec![
        "stat".into(),
        "-c".into(),
        "%s %Y".into(),
        "--".into(),
        path.into(),
    ]
}

/// Argv printing `path`'s size in bytes. Pure.
fn size_argv(path: &str) -> Vec<String> {
    vec![
        "sh".into(),
        "-c".into(),
        SIZE_SCRIPT.into(),
        "sh".into(),
        path.into(),
    ]
}

/// Argv removing `path` (a missing file is not an error). Pure.
fn remove_argv(path: &str) -> Vec<String> {
    vec!["rm".into(), "-f".into(), "--".into(), path.into()]
}

/// Parse `stat -c '%s %Y'` output into a fingerprint. Pure.
fn parse_fingerprint(output: &str) -> Option<SourceFingerprint> {
    let mut fields = output.split_whitespace();
    let size = fields.next()?.parse().ok()?;
    let mtime = fields.next()?.parse().ok()?;
    Some(SourceFingerprint {
        size,
        mtime: Some(mtime),
    })
}

/// Parse `wc -c` output (busybox pads with spaces) into a size. Pure.
fn parse_size(output: &str) -> Option<u64> {
    output.trim().parse().ok()
}

/// Borrow an owned argv as the `&str` slice the exec helpers take.
fn as_strs(argv: &[String]) -> Vec<&str> {
    argv.iter().map(String::as_str).collect()
}

/// Map an exec transport error into a [`FileError`].
fn op_err(what: &str, e: impl std::fmt::Display) -> FileError {
    FileError::OperationFailed(format!("{what}: {e}"))
}

/// Append a stderr frame to the capped buffer.
fn push_stderr(buf: &Mutex<Vec<u8>>, message: &[u8]) {
    if let Ok(mut buf) = buf.lock() {
        let room = STDERR_CAP.saturating_sub(buf.len());
        buf.extend_from_slice(&message[..message.len().min(room)]);
    }
}

type OutputStream = Pin<Box<dyn Stream<Item = Result<LogOutput, bollard::errors::Error>> + Send>>;

/// Wait for the daemon to report an exec's exit code, then map a non-zero or
/// unknown code to an error carrying the captured stderr.
async fn wait_exit(
    client: &bollard::Docker,
    exec_id: &str,
    stderr: &Mutex<Vec<u8>>,
) -> Result<(), FileError> {
    let deadline = tokio::time::Instant::now() + EXIT_WAIT;
    loop {
        let inspect = client
            .inspect_exec(exec_id)
            .await
            .map_err(|e| op_err("Failed to inspect exec", e))?;
        if inspect.running != Some(true) || tokio::time::Instant::now() >= deadline {
            let stderr = stderr.lock().map(|b| b.clone()).unwrap_or_default();
            return check_exec_exit_code(inspect.exit_code, &stderr);
        }
        tokio::time::sleep(EXIT_POLL).await;
    }
}

/// A container's stdout, streamed as an [`AsyncRead`] with bounded memory
/// (one daemon frame at a time). Reaching EOF does **not** mean success — the
/// process may have been killed mid-file — so the caller must [`finish`]
/// before trusting the bytes.
///
/// [`finish`]: ExecReader::finish
pub struct ExecReader {
    client: bollard::Docker,
    exec_id: String,
    reader: Pin<Box<dyn AsyncRead + Send>>,
    stderr: Arc<Mutex<Vec<u8>>>,
}

impl ExecReader {
    fn new(client: bollard::Docker, exec_id: String, output: OutputStream) -> Self {
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let sink = stderr.clone();
        let stdout = output.filter_map(move |frame| {
            let item = match frame {
                Ok(LogOutput::StdOut { message }) => Some(Ok(message)),
                Ok(LogOutput::StdErr { message }) => {
                    push_stderr(&sink, &message);
                    None
                }
                Ok(_) => None,
                Err(e) => Some(Err(std::io::Error::other(e))),
            };
            std::future::ready(item)
        });
        Self {
            client,
            exec_id,
            reader: Box::pin(tokio_util::io::StreamReader::new(stdout)),
            stderr,
        }
    }

    /// Confirm the producing command exited `0` after its stdout hit EOF.
    pub async fn finish(self) -> Result<(), FileError> {
        wait_exit(&self.client, &self.exec_id, &self.stderr).await
    }
}

impl AsyncRead for ExecReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        self.reader.as_mut().poll_read(cx, buf)
    }
}

/// A container command's stdin, as an [`AsyncWrite`]. Call [`finish`] to
/// close stdin and confirm the command wrote everything and exited `0`.
///
/// Every write first checks whether the command has already exited (its
/// output stream ended): a `cat` that could not open its destination, or was
/// killed, fails the next write at once with its stderr — instead of the
/// write blocking on a stdin nobody reads until the stall watchdog fires.
///
/// [`finish`]: ExecWriter::finish
pub struct ExecWriter {
    client: bollard::Docker,
    exec_id: String,
    input: Pin<Box<dyn AsyncWrite + Send>>,
    output: OutputStream,
    stderr: Mutex<Vec<u8>>,
    exited: bool,
}

impl ExecWriter {
    fn new(
        client: bollard::Docker,
        exec_id: String,
        input: Pin<Box<dyn AsyncWrite + Send>>,
        output: OutputStream,
    ) -> Self {
        Self {
            client,
            exec_id,
            input,
            output,
            stderr: Mutex::new(Vec::new()),
            exited: false,
        }
    }

    /// Drain whatever output is ready without blocking; returns whether the
    /// command's output has ended (the command exited). Registers the waker
    /// so a blocked write is re-polled when the command dies.
    fn poll_exited(&mut self, cx: &mut Context<'_>) -> bool {
        while !self.exited {
            match self.output.as_mut().poll_next(cx) {
                Poll::Ready(Some(Ok(LogOutput::StdErr { message }))) => {
                    push_stderr(&self.stderr, &message);
                }
                Poll::Ready(Some(Ok(_))) => {}
                Poll::Ready(Some(Err(_)) | None) => self.exited = true,
                Poll::Pending => break,
            }
        }
        self.exited
    }

    /// The error a write returns once the command has exited early.
    fn exited_error(&self) -> std::io::Error {
        let stderr = self.stderr.lock().map(|b| b.clone()).unwrap_or_default();
        let stderr = String::from_utf8_lossy(&stderr);
        let detail = match stderr.trim() {
            "" => String::new(),
            text => format!(": {text}"),
        };
        std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            format!("container command exited before reading all input{detail}"),
        )
    }

    /// Close stdin (EOF for the command), drain its output, and confirm it
    /// exited `0` — only then have the bytes landed in the file.
    pub async fn finish(mut self) -> Result<(), FileError> {
        self.input
            .shutdown()
            .await
            .map_err(|e| op_err("Failed to close stdin", e))?;
        while !self.exited {
            match self.output.next().await {
                Some(Ok(LogOutput::StdErr { message })) => push_stderr(&self.stderr, &message),
                Some(Ok(_)) => {}
                Some(Err(e)) => return Err(op_err("Exec output error", e)),
                None => self.exited = true,
            }
        }
        wait_exit(&self.client, &self.exec_id, &self.stderr).await
    }
}

impl AsyncWrite for ExecWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let this = self.get_mut();
        if this.poll_exited(cx) {
            return Poll::Ready(Err(this.exited_error()));
        }
        this.input.as_mut().poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        if this.poll_exited(cx) {
            return Poll::Ready(Err(this.exited_error()));
        }
        this.input.as_mut().poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        self.input.as_mut().poll_shutdown(cx)
    }
}

/// A cloneable handle to one container for a background streaming transfer —
/// the Docker counterpart of an SFTP dedicated channel. It owns its own client
/// handle, so a transfer never holds the session lock and browsing stays live.
#[derive(Clone)]
pub struct DockerTransferTarget {
    client: bollard::Docker,
    container_id: String,
}

impl std::fmt::Debug for DockerTransferTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DockerTransferTarget")
            .field("container_id", &self.container_id)
            .finish_non_exhaustive()
    }
}

/// Recover the streaming transfer handle from a Docker session's
/// `&dyn FileBrowser`, or `None` for any other backend.
pub fn docker_transfer_target_of(browser: &dyn FileBrowser) -> Option<DockerTransferTarget> {
    browser
        .as_any()?
        .downcast_ref::<DockerFileBrowser>()
        .map(DockerFileBrowser::transfer_target)
}

impl DockerTransferTarget {
    /// Build a target for `container_id` on `client`.
    pub fn new(client: bollard::Docker, container_id: String) -> Self {
        Self {
            client,
            container_id,
        }
    }

    /// The container this target streams into / out of.
    pub fn container_id(&self) -> &str {
        &self.container_id
    }

    /// Probe which streaming tools the container provides.
    pub async fn probe(&self) -> Result<ContainerCaps, FileError> {
        let out = exec_command(
            &self.client,
            &self.container_id,
            vec!["sh", "-c", PROBE_SCRIPT],
        )
        .await?;
        Ok(ContainerCaps::parse(&out))
    }

    /// Size + mtime of a container file, or `None` when absent / un-stattable.
    pub async fn fingerprint(&self, path: &str) -> Option<SourceFingerprint> {
        let argv = fingerprint_argv(path);
        let out = exec_command(&self.client, &self.container_id, as_strs(&argv))
            .await
            .ok()?;
        parse_fingerprint(&out)
    }

    /// Size of a container file, or `None` when absent / unmeasurable.
    pub async fn file_size(&self, path: &str) -> Option<u64> {
        let argv = size_argv(path);
        let out = exec_command(&self.client, &self.container_id, as_strs(&argv))
            .await
            .ok()?;
        parse_size(&out)
    }

    /// Remove a container file (best-effort partial cleanup; missing is fine).
    pub async fn remove_file(&self, path: &str) -> Result<(), FileError> {
        let argv = remove_argv(path);
        exec_command(&self.client, &self.container_id, as_strs(&argv)).await?;
        Ok(())
    }

    /// Start streaming `path` from byte `offset` (needs
    /// [`ContainerCaps::offset_read`] when `offset > 0`).
    pub async fn open_read(&self, path: &str, offset: u64) -> Result<ExecReader, FileError> {
        let argv = read_argv(path, offset);
        let (exec_id, output, _input) = self.start(as_strs(&argv), false).await?;
        Ok(ExecReader::new(self.client.clone(), exec_id, output))
    }

    /// Start writing `path` from stdin — appending to the existing file, or
    /// creating/truncating it.
    pub async fn open_write(&self, path: &str, append: bool) -> Result<ExecWriter, FileError> {
        let argv = write_argv(path, append);
        let (exec_id, output, input) = self.start(as_strs(&argv), true).await?;
        Ok(ExecWriter::new(self.client.clone(), exec_id, input, output))
    }

    /// Create and attach a streaming exec (under the C locale).
    async fn start(
        &self,
        cmd: Vec<&str>,
        stdin: bool,
    ) -> Result<(String, OutputStream, Pin<Box<dyn AsyncWrite + Send>>), FileError> {
        let exec = self
            .client
            .create_exec(
                &self.container_id,
                CreateExecOptions {
                    attach_stdin: Some(stdin),
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    cmd: Some(with_c_locale(cmd)),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| op_err("Failed to create exec", e))?;
        let started = self
            .client
            .start_exec(
                &exec.id,
                Some(StartExecOptions {
                    detach: false,
                    ..Default::default()
                }),
            )
            .await
            .map_err(|e| op_err("Failed to start exec", e))?;
        match started {
            StartExecResults::Attached { output, input } => Ok((exec.id, output, input)),
            StartExecResults::Detached => Err(FileError::OperationFailed(
                "Exec started in detached mode".to_string(),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A hostile path: quotes, `$(...)`, backticks, `;`, spaces, newline, and
    /// a leading dash — every shell metacharacter class at once.
    const HOSTILE: &str = "-x '$(rm -rf /)`id`; echo \"pwn\"\n.bin";

    #[test]
    fn probe_output_parses_every_capability() {
        let caps = ContainerCaps::parse("cat\ntail\nstat\nwc\n");
        assert_eq!(
            caps,
            ContainerCaps {
                cat: true,
                offset_read: true,
                stat: true,
                size: true,
            }
        );
    }

    #[test]
    fn probe_output_missing_tools_are_absent() {
        let caps = ContainerCaps::parse("cat\nwc\n");
        assert!(caps.cat && caps.size);
        assert!(!caps.offset_read && !caps.stat);
        assert_eq!(ContainerCaps::parse(""), ContainerCaps::default());
    }

    #[test]
    fn fresh_read_streams_whole_file_via_redirect() {
        assert_eq!(
            read_argv("/tmp/a b.bin", 0),
            ["sh", "-c", READ_ALL_SCRIPT, "sh", "/tmp/a b.bin"]
        );
    }

    #[test]
    fn offset_read_uses_one_based_tail() {
        // Skipping 1000 bytes starts at the 1001st byte.
        assert_eq!(
            read_argv("/f", 1000),
            ["sh", "-c", READ_FROM_SCRIPT, "sh", "/f", "1001"]
        );
        assert_eq!(read_argv("/f", 1)[5], "2");
    }

    #[test]
    fn write_argv_selects_truncate_or_append() {
        assert_eq!(write_argv("/f", false)[2], WRITE_SCRIPT);
        assert_eq!(write_argv("/f", true)[2], APPEND_SCRIPT);
        assert!(WRITE_SCRIPT.contains("cat > \"$1\""));
        assert!(APPEND_SCRIPT.contains("cat >> \"$1\""));
    }

    #[test]
    fn hostile_paths_are_passed_as_a_single_positional_argument() {
        for argv in [
            read_argv(HOSTILE, 0),
            read_argv(HOSTILE, 7),
            write_argv(HOSTILE, false),
            write_argv(HOSTILE, true),
            size_argv(HOSTILE),
        ] {
            // The path is exactly one argv element after the `sh` $0 marker,
            // and the script itself never contains it.
            assert_eq!(argv[..2], ["sh", "-c"]);
            assert_eq!(argv[3], "sh");
            assert_eq!(argv[4], HOSTILE);
            assert!(!argv[2].contains(HOSTILE));
        }
        assert_eq!(
            fingerprint_argv(HOSTILE).last().map(String::as_str),
            Some(HOSTILE)
        );
        assert_eq!(remove_argv(HOSTILE), ["rm", "-f", "--", HOSTILE]);
    }

    #[test]
    fn scripts_only_reference_quoted_positionals() {
        for script in [
            READ_ALL_SCRIPT,
            READ_FROM_SCRIPT,
            WRITE_SCRIPT,
            APPEND_SCRIPT,
            SIZE_SCRIPT,
        ] {
            // Every `$` is a quoted positional (`"$1"` / `"+$2"`), so no path
            // byte is ever word-split, globbed, or evaluated.
            for (i, _) in script.match_indices('$') {
                let next = &script[i + 1..i + 2];
                assert!(next == "1" || next == "2", "{script}");
                assert_eq!(&script[i + 2..i + 3], "\"", "{script}");
            }
        }
    }

    #[test]
    fn fingerprint_parses_size_and_mtime() {
        assert_eq!(
            parse_fingerprint("1048576 1700000000\n"),
            Some(SourceFingerprint {
                size: 1_048_576,
                mtime: Some(1_700_000_000),
            })
        );
        assert_eq!(parse_fingerprint(""), None);
        assert_eq!(parse_fingerprint("abc 1"), None);
        assert_eq!(parse_fingerprint("12"), None);
    }

    #[test]
    fn size_parses_busybox_padding() {
        assert_eq!(parse_size("   4096\n"), Some(4096));
        assert_eq!(parse_size("0"), Some(0));
        assert_eq!(parse_size(""), None);
        assert_eq!(parse_size("wc: can't open"), None);
    }

    #[test]
    fn stderr_buffer_is_capped() {
        let buf = Mutex::new(Vec::new());
        push_stderr(&buf, &vec![b'x'; STDERR_CAP + 100]);
        push_stderr(&buf, b"more");
        assert_eq!(buf.lock().expect("lock").len(), STDERR_CAP);
    }

    fn offline_client() -> bollard::Docker {
        bollard::Docker::connect_with_http("http://127.0.0.1:1", 1, bollard::API_DEFAULT_VERSION)
            .expect("client")
    }

    #[tokio::test]
    async fn exec_writer_fails_fast_with_stderr_once_the_command_exited() {
        let frames: Vec<Result<LogOutput, bollard::errors::Error>> = vec![Ok(LogOutput::StdErr {
            message: b"sh: can't create /nope/x: nonexistent directory\n"
                .to_vec()
                .into(),
        })];
        let output: OutputStream = Box::pin(futures_util::stream::iter(frames));
        let mut writer = ExecWriter::new(
            offline_client(),
            "x".into(),
            Box::pin(tokio::io::sink()),
            output,
        );
        let err = writer.write_all(b"data").await.expect_err("exited early");
        assert_eq!(err.kind(), std::io::ErrorKind::BrokenPipe);
        assert!(err.to_string().contains("nonexistent directory"), "{err}");
    }

    #[tokio::test]
    async fn exec_writer_passes_writes_through_while_the_command_runs() {
        let output: OutputStream = Box::pin(futures_util::stream::pending());
        let mut writer = ExecWriter::new(
            offline_client(),
            "x".into(),
            Box::pin(tokio::io::sink()),
            output,
        );
        writer.write_all(b"data").await.expect("write");
        writer.flush().await.expect("flush");
    }

    #[tokio::test]
    async fn exec_reader_yields_stdout_only_and_captures_stderr() {
        use tokio::io::AsyncReadExt;
        let frames: Vec<Result<LogOutput, bollard::errors::Error>> = vec![
            Ok(LogOutput::StdOut {
                message: b"hello ".to_vec().into(),
            }),
            Ok(LogOutput::StdErr {
                message: b"warn".to_vec().into(),
            }),
            Ok(LogOutput::StdOut {
                message: b"world".to_vec().into(),
            }),
        ];
        let output: OutputStream = Box::pin(futures_util::stream::iter(frames));
        let mut reader = ExecReader::new(offline_client(), "x".into(), output);
        let mut out = Vec::new();
        reader.read_to_end(&mut out).await.expect("read");
        assert_eq!(out, b"hello world");
        assert_eq!(reader.stderr.lock().expect("lock").as_slice(), b"warn");
    }
}

#![cfg(all(windows, feature = "local-shell"))]
//! A real PTY session on the sideloaded ConPTY host (#4130).
//!
//! The Windows bundle ships Microsoft's `conpty.dll` + `OpenConsole.exe` next
//! to `termihub.exe` (#4121). portable-pty loads `conpty.dll` by bare name, so
//! the packaged host is used whenever that DLL is found, and the packaged host
//! differs from the inbox one in two ways this test pins down:
//!
//! - it passes a SIXEL DCS string written by the child through to the PTY
//!   reader **byte for byte** (the inbox host drops it), and
//! - it sends a DA1 query (`ESC [ c`) right after its opening cursor query
//!   (`ESC [ 6 n`) and holds the child's output for up to 3 s until the DA1 is
//!   answered. `backends::conpty_cursor` answers both at the reader seam and
//!   strips them from the stream.
//!
//! `cargo test` binaries live in `target/<profile>/deps/`, where no
//! `conpty.dll` sits, so without help every PTY test runs on the inbox host.
//! This binary therefore **preloads** the staged `conpty.dll` by its full path
//! before the first PTY spawn. Windows resolves a later bare-name
//! `LoadLibraryW("conpty.dll")` to a module that is already loaded, wherever it
//! came from, so portable-pty picks up exactly that DLL, and the DLL starts the
//! `OpenConsole.exe` beside it. Preloading (rather than copying the files next
//! to the test binary) keeps the other test binaries in `deps/` on the inbox
//! host, and it only affects this process: the test is its own test binary.
//!
//! The staged directory comes from `TERMIHUB_TEST_CONPTY_DIR`, filled by
//! `scripts/internal/fetch-conpty.sh --dest <dir>` (the Windows Rust legs of
//! `code-quality.yml` and `agent.yml` do this). Without it the test skips with
//! a `SKIPPED:` line locally, but **fails on a GitHub Actions runner**, so a CI
//! leg that stops staging the host cannot lose this coverage silently.
//!
//! The PTY child is this same test binary, re-run as
//! [`sideloaded_conpty_child_helper`]: it turns on VT processing for its
//! console and writes a SIXEL image framed by text markers, so the bytes the
//! host receives are fully under the test's control.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use termihub_core::backends::local_shell::NativeLocalShellSpawner;
use termihub_core::session::shell::ShellCommand;
use termihub_core::session::traits::LocalShellSpawner;

/// Directory holding the staged `conpty.dll` + `OpenConsole.exe`.
const CONPTY_DIR_ENV: &str = "TERMIHUB_TEST_CONPTY_DIR";

/// Set in the PTY child's environment: run the helper body instead of a no-op.
const CHILD_ENV: &str = "TERMIHUB_SIDELOADED_CONPTY_CHILD";

/// The files `fetch-conpty.sh` stages.
const STAGED_FILES: [&str; 2] = ["conpty.dll", "OpenConsole.exe"];

/// A 4x6 px red SIXEL image (DCS q … ST), the same bytes as the system tests.
const SIXEL: &[u8] = b"\x1bPq#0;2;100;0;0#0~~~~-\x1b\\";
const BEFORE: &[u8] = b"TH_CONPTY_SIXEL_BEFORE";
const AFTER: &[u8] = b"TH_CONPTY_SIXEL_AFTER";

/// The startup queries the reader seam must answer and strip.
const CURSOR_QUERY: &[u8] = b"\x1b[6n";
const DA1_QUERY: &[u8] = b"\x1b[c";

/// Upper bound for the child's first output after the spawn. An unanswered DA1
/// makes the packaged host hold the output for 3 s; the child (this binary,
/// already in the file cache) starts far faster than this.
const FIRST_OUTPUT_BUDGET: Duration = Duration::from_millis(2500);

/// How long to wait for the whole frame before giving up.
const FRAME_DEADLINE: Duration = Duration::from_secs(60);

/// The PTY child. A no-op unless [`CHILD_ENV`] is set, which only the parent
/// test does, for the copy of this binary it runs inside the PTY.
#[test]
fn sideloaded_conpty_child_helper() {
    if std::env::var_os(CHILD_ENV).is_none() {
        return;
    }
    enable_vt_output();
    let mut out = std::io::stdout();
    let mut frame = Vec::new();
    frame.extend_from_slice(BEFORE);
    frame.extend_from_slice(b"\r\n");
    frame.extend_from_slice(SIXEL);
    frame.extend_from_slice(AFTER);
    frame.extend_from_slice(b"\r\n");
    out.write_all(&frame).expect("write the SIXEL frame");
    out.flush().expect("flush the SIXEL frame");
    // Stay alive until the parent kills the PTY: an exiting child could race
    // the host's last flush.
    std::thread::sleep(FRAME_DEADLINE);
}

#[test]
fn sideloaded_conpty_passes_sixel_and_answers_startup_queries() {
    let Some(dir) = staged_conpty_dir() else {
        return;
    };
    preload_conpty(&dir);

    let exe = std::env::current_exe().expect("current_exe");
    let command = ShellCommand {
        program: exe.to_string_lossy().into_owned(),
        args: vec![
            "sideloaded_conpty_child_helper".into(),
            "--exact".into(),
            "--nocapture".into(),
            "--test-threads=1".into(),
        ],
        env: HashMap::from([(CHILD_ENV.to_string(), "1".to_string())]),
        cwd: None,
        cols: 120,
        rows: 30,
    };

    let started = Instant::now();
    let spawned = NativeLocalShellSpawner
        .spawn(&command)
        .expect("spawn the child on the sideloaded ConPTY host");

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let mut reader = spawned.reader;
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        return;
                    }
                }
            }
        }
    });

    let mut stream = Vec::new();
    let mut first_output: Option<Duration> = None;
    let deadline = started + FRAME_DEADLINE;
    while find(&stream, AFTER).is_none() {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        match rx.recv_timeout(left) {
            Ok(chunk) => {
                stream.extend_from_slice(&chunk);
                if first_output.is_none() && find(&stream, BEFORE).is_some() {
                    first_output = Some(started.elapsed());
                }
            }
            Err(_) => break,
        }
    }
    (spawned.kill)();
    (spawned.close_pty)();

    let shown = String::from_utf8_lossy(&stream).escape_debug().to_string();
    assert!(
        find(&stream, AFTER).is_some(),
        "the child's output never arrived within {FRAME_DEADLINE:?} \
         (an unanswered cursor query stalls the host forever); got: {shown}"
    );
    assert!(
        find(&stream, SIXEL).is_some(),
        "the SIXEL DCS did not arrive byte for byte, so the sideloaded host from \
         {} was not used (the inbox host drops it); got: {shown}",
        dir.display()
    );
    assert!(
        find(&stream, CURSOR_QUERY).is_none(),
        "the host's cursor query leaked into the output; got: {shown}"
    );
    assert!(
        find(&stream, DA1_QUERY).is_none(),
        "the host's DA1 query leaked into the output (it was not answered at the \
         reader seam); got: {shown}"
    );
    let first_output = first_output.expect("BEFORE arrived together with AFTER");
    assert!(
        first_output < FIRST_OUTPUT_BUDGET,
        "the child's first output took {first_output:?} (budget {FIRST_OUTPUT_BUDGET:?}); \
         the host held it back, which is the 3 s wait for an unanswered DA1"
    );
}

/// The staged host directory, or `None` (after a `SKIPPED:` line) when it is
/// not configured outside CI. Panics when it is missing on a GitHub Actions
/// runner, or when the variable points at a directory without the files.
fn staged_conpty_dir() -> Option<PathBuf> {
    let Some(dir) = std::env::var_os(CONPTY_DIR_ENV).filter(|v| !v.is_empty()) else {
        let reason = format!(
            "{CONPTY_DIR_ENV} is not set; stage the host with \
             `scripts/internal/fetch-conpty.sh --dest <dir>` and point it there"
        );
        assert!(
            std::env::var("GITHUB_ACTIONS").as_deref() != Ok("true"),
            "{reason}. CI must run this test: the Windows Rust leg stages the host"
        );
        eprintln!("SKIPPED: sideloaded ConPTY test: {reason}");
        return None;
    };
    let dir = PathBuf::from(dir);
    let missing: Vec<&str> = STAGED_FILES
        .into_iter()
        .filter(|name| !dir.join(name).is_file())
        .collect();
    assert!(
        missing.is_empty(),
        "{} missing in {CONPTY_DIR_ENV}={}; stage the host with \
         `scripts/internal/fetch-conpty.sh --dest <dir>`",
        missing.join(", "),
        dir.display()
    );
    Some(dir)
}

/// Load `<dir>\conpty.dll` so portable-pty's bare-name load resolves to it.
fn preload_conpty(dir: &Path) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::LibraryLoader::LoadLibraryW;

    let dll = dir.join("conpty.dll");
    let wide: Vec<u16> = dll.as_os_str().encode_wide().chain([0]).collect();
    // SAFETY: `wide` is a NUL-terminated UTF-16 path that outlives the call.
    // The module is never freed: portable-pty keeps using it for the rest of
    // the process.
    let module = unsafe { LoadLibraryW(wide.as_ptr()) };
    assert!(
        !module.is_null(),
        "LoadLibraryW({}) failed: {}",
        dll.display(),
        std::io::Error::last_os_error()
    );
}

/// Turn on VT processing for this process's console output, so the SIXEL
/// written below reaches the host as an escape sequence, not as text.
fn enable_vt_output() {
    use windows_sys::Win32::System::Console::{
        GetConsoleMode, GetStdHandle, SetConsoleMode, ENABLE_PROCESSED_OUTPUT,
        ENABLE_VIRTUAL_TERMINAL_PROCESSING, STD_OUTPUT_HANDLE,
    };

    // SAFETY: plain Win32 console calls on this process's own stdout handle;
    // `mode` is a valid out-pointer for the duration of the call.
    unsafe {
        let handle = GetStdHandle(STD_OUTPUT_HANDLE);
        let mut mode = 0;
        assert!(
            GetConsoleMode(handle, &mut mode) != 0,
            "stdout is not a console: {}",
            std::io::Error::last_os_error()
        );
        assert!(
            SetConsoleMode(
                handle,
                mode | ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING
            ) != 0,
            "SetConsoleMode(VT processing) failed: {}",
            std::io::Error::last_os_error()
        );
    }
}

/// Index of the first occurrence of `needle` in `haystack`.
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

//! Live WSL tests against a **real** distribution (#4008).
//!
//! The unit tests in [`super::tests`] and [`super::super::wsl_init_script`]
//! prove the pure logic on every platform; these drive the real `wsl.exe`, the
//! real ConPTY and the real `\\wsl$` share, covering three walkthroughs that
//! used to be manual:
//!
//! - **Symlink listing (#1523)** — [`WslFileBrowser::list_dir`] over the UNC
//!   share flags a file link, a directory link and a dangling link, and reads
//!   the link target.
//! - **Init script (#2837)** — the distro-side create makes the file `0600` with
//!   the exact content and refuses to clobber it; a real session shows only the
//!   `source` line, the script removes itself, and the sourced hook tracks the
//!   CWD via OSC 7.
//! - **Queued folder copy (#3567, PARITY-004)** — a folder with a file above the
//!   direct-copy threshold round-trips Windows → WSL → Windows through the
//!   local transfer queue, using the `//wsl$/<distro>/…` paths the frontend
//!   passes.
//!
//! # Gate
//!
//! Each test needs an installed distribution. Without one it prints a visible
//! `SKIPPED:` line and passes — unless `TERMIHUB_REQUIRE_WSL` is set (truthy),
//! in which case a missing distribution is a hard failure. The `WSL Live
//! (Windows)` workflow (`.github/workflows/wsl-live.yml`) installs a distro and
//! sets it, so a broken WSL setup reds that lane instead of skipping to a false
//! green — the WSL twin of `TERMIHUB_REQUIRE_DOCKER`. `TERMIHUB_WSL_DISTRO`
//! pins the distribution to use; otherwise the first installed one is taken.
//!
//! The whole module is Windows-only: the parent `wsl` module is compiled only
//! under `cfg(all(feature = "wsl", windows))`.

use std::process::{Child, Command, Output, Stdio};
use std::time::Duration;

use super::*;

/// Env var that turns a missing distribution from a skip into a hard failure.
const REQUIRE_WSL_ENV: &str = "TERMIHUB_REQUIRE_WSL";

/// Env var that pins the distribution the tests run against.
const DISTRO_ENV: &str = "TERMIHUB_WSL_DISTRO";

/// How long to wait for a live session to show an expected byte sequence. A
/// cold WSL 2 VM can take tens of seconds to boot on a CI runner.
const SESSION_TIMEOUT: Duration = Duration::from_secs(90);

/// Whether [`REQUIRE_WSL_ENV`] is set to a truthy value (`1`, `true`, `yes`,
/// `on`; case-insensitive), mirroring `TERMIHUB_REQUIRE_DOCKER`.
fn wsl_required() -> bool {
    matches!(
        std::env::var(REQUIRE_WSL_ENV)
            .ok()
            .map(|v| v.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// The distribution to test against, or `None` (after a `SKIPPED:` line) when
/// none is installed and none is required. Panics when one is required but
/// absent.
///
/// Docker Desktop's internal distributions have no usable shell, so they are
/// never picked automatically.
fn live_distro() -> Option<String> {
    let distro = std::env::var(DISTRO_ENV)
        .ok()
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .or_else(|| {
            detect_wsl_distros()
                .into_iter()
                .find(|d| !d.starts_with("docker-desktop"))
        });
    match distro {
        Some(distro) => Some(distro),
        None if wsl_required() => panic!(
            "REQUIRED WSL distribution unavailable: `wsl.exe --list --quiet` reports none \
             but {REQUIRE_WSL_ENV} is set — a missing distro is a hard failure here, not a skip"
        ),
        None => {
            eprintln!(
                "SKIPPED: no WSL distribution installed \
                 (set {REQUIRE_WSL_ENV}=1 to make this a failure)"
            );
            None
        }
    }
}

/// Run `program` with `sh -c` inside `distro` (positional args as `$1…`).
fn wsl_sh(distro: &str, program: &str, args: &[&str]) -> Output {
    Command::new("wsl.exe")
        .args(distro_sh_args(distro, program, args))
        .stdin(Stdio::null())
        .output()
        .expect("spawn wsl.exe")
}

/// [`wsl_sh`], asserting success; returns stdout.
fn wsl_ok(distro: &str, program: &str, args: &[&str]) -> Vec<u8> {
    let out = wsl_sh(distro, program, args);
    assert!(
        out.status.success(),
        "wsl.exe `{program}` failed with {}: stdout={:?} stderr={:?}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    out.stdout
}

/// Keeps the distribution (and, on WSL 2, its VM) running for the test's
/// lifetime, so the `\\wsl$` share and the helper `wsl.exe` spawns never race
/// an idle shutdown. Killed on drop.
struct KeepAlive(Child);

impl KeepAlive {
    fn start(distro: &str) -> Self {
        let child = Command::new("wsl.exe")
            .args(["-d", distro, "--exec", "sleep", "900"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn keep-alive wsl.exe");
        // Fail fast with a clear message when the distro cannot start at all.
        wsl_ok(distro, "true", &[]);
        Self(child)
    }
}

impl Drop for KeepAlive {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A unique scratch directory inside the distribution, removed on drop.
struct Scratch {
    distro: String,
    path: String,
}

impl Scratch {
    fn new(distro: &str) -> Self {
        let path = format!("/tmp/termihub-4008-{}", uuid::Uuid::new_v4());
        wsl_ok(distro, "mkdir -p \"$1\"", &[&path]);
        Self {
            distro: distro.to_string(),
            path,
        }
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = wsl_sh(&self.distro, "rm -rf \"$1\"", &[&self.path]);
    }
}

/// Normalize a link target read over the UNC share for comparison.
fn norm(target: Option<&str>) -> String {
    target.unwrap_or_default().replace('\\', "/")
}

// ---------------------------------------------------------------------------
// #1523 — symlink icon and target over the UNC share
// ---------------------------------------------------------------------------

#[tokio::test]
async fn live_wsl_list_dir_reports_symlinks_and_targets() {
    let Some(distro) = live_distro() else {
        return;
    };
    let _alive = KeepAlive::start(&distro);
    let dir = Scratch::new(&distro);
    wsl_ok(
        &distro,
        "cd \"$1\" && printf hello > real.txt && mkdir realdir \
         && ln -s real.txt link.txt && ln -s realdir linkdir \
         && ln -s does-not-exist dangling",
        &[&dir.path],
    );

    let browser = WslFileBrowser::new(distro.clone());
    let entries = browser
        .list_dir(&dir.path)
        .await
        .expect("list_dir over the WSL share (a dangling link must not fail the listing)");
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    let find = |name: &str| {
        entries
            .iter()
            .find(|e| e.name == name)
            .unwrap_or_else(|| panic!("{name} missing from listing {names:?}"))
    };

    let real = find("real.txt");
    assert!(!real.is_symlink, "regular file flagged as a link: {real:?}");
    assert!(!real.is_directory);
    assert_eq!(real.symlink_target, None);
    assert_eq!(real.path, format!("{}/real.txt", dir.path));

    let realdir = find("realdir");
    assert!(realdir.is_directory, "directory not flagged: {realdir:?}");
    assert!(!realdir.is_symlink);

    let link = find("link.txt");
    assert!(link.is_symlink, "file symlink not flagged: {link:?}");
    assert!(
        norm(link.symlink_target.as_deref()).ends_with("real.txt"),
        "file symlink target not read: {link:?}"
    );

    let linkdir = find("linkdir");
    assert!(
        linkdir.is_symlink,
        "directory symlink not flagged: {linkdir:?}"
    );
    assert!(
        norm(linkdir.symlink_target.as_deref()).ends_with("realdir"),
        "directory symlink target not read: {linkdir:?}"
    );

    let dangling = find("dangling");
    assert!(
        dangling.is_symlink,
        "dangling symlink not flagged: {dangling:?}"
    );
}

// ---------------------------------------------------------------------------
// #2837 — init script created inside the distro with mode 0600
// ---------------------------------------------------------------------------

/// Removes a distro-side file on drop (the test's own init-script path).
struct RemoveOnDrop<'a>(&'a str, &'a str);

impl Drop for RemoveOnDrop<'_> {
    fn drop(&mut self) {
        let _ = wsl_sh(self.0, "rm -f \"$1\"", &[self.1]);
    }
}

#[test]
fn live_wsl_init_script_is_created_0600_with_exact_content_and_never_clobbered() {
    let Some(distro) = live_distro() else {
        return;
    };
    let _alive = KeepAlive::start(&distro);
    let path = init_script_linux_path();
    let _cleanup = RemoveOnDrop(&distro, &path);
    let contents = init_script_contents("echo live-4008", &path);

    create_init_script_in_distro(&distro, &path, contents.as_bytes())
        .expect("distro-side 0600 create");

    let probe = "stat -c %a \"$1\" && cat \"$1\"";
    let stdout = wsl_ok(&distro, probe, &[&path]);
    assert_eq!(
        String::from_utf8_lossy(&stdout),
        format!("600\n{contents}"),
        "init script must be mode 0600 with exactly the generated content"
    );

    // A second create on the same path is refused and leaves the file as is.
    let clobber = create_init_script_in_distro(&distro, &path, b"clobbered\n");
    assert!(
        clobber.is_err(),
        "an existing init script must not be overwritten"
    );
    let stdout = wsl_ok(&distro, probe, &[&path]);
    assert_eq!(String::from_utf8_lossy(&stdout), format!("600\n{contents}"));
}

/// Everything a live session printed, searchable while it streams in.
struct Transcript<'a> {
    rx: &'a mut OutputReceiver,
    buf: Vec<u8>,
}

impl<'a> Transcript<'a> {
    fn new(rx: &'a mut OutputReceiver) -> Self {
        Self {
            rx,
            buf: Vec::new(),
        }
    }

    /// Wait until one of `needles` appears at or after byte `from`; returns
    /// `(needle index, match offset)`. Panics with the transcript on timeout.
    async fn wait_any(&mut self, needles: &[&[u8]], from: usize) -> (usize, usize) {
        let deadline = tokio::time::Instant::now() + SESSION_TIMEOUT;
        loop {
            for (i, needle) in needles.iter().enumerate() {
                if let Some(pos) = self
                    .buf
                    .get(from..)
                    .and_then(|hay| hay.windows(needle.len()).position(|w| w == *needle))
                {
                    return (i, from + pos);
                }
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(remaining, self.rx.recv()).await {
                Ok(Some(chunk)) => self.buf.extend_from_slice(&chunk),
                _ => panic!(
                    "none of {:?} appeared in the WSL session output:\n{:?}",
                    needles
                        .iter()
                        .map(|n| String::from_utf8_lossy(n))
                        .collect::<Vec<_>>(),
                    String::from_utf8_lossy(&self.buf)
                ),
            }
        }
    }

    async fn wait_for(&mut self, needle: &[u8], from: usize) -> usize {
        self.wait_any(&[needle], from).await.1
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.buf).into_owned()
    }
}

#[tokio::test]
async fn live_wsl_session_sources_init_script_silently_self_cleans_and_tracks_cwd() {
    let Some(distro) = live_distro() else {
        return;
    };
    let _alive = KeepAlive::start(&distro);

    let mut wsl = Wsl::new();
    // Subscribe before connecting so no early output is lost.
    let mut rx = wsl.subscribe_output();
    wsl.connect(serde_json::json!({ "distribution": distro }))
        .await
        .expect("connect");
    // Wide enough that the echoed `source` line never wraps mid-path.
    wsl.resize(400, 50).expect("resize");
    let mut out = Transcript::new(&mut rx);

    // 1. Only the `source` line is injected; the script's own notice follows.
    let prefix = format!("source {INIT_SCRIPT_PREFIX}");
    let at = out.wait_for(prefix.as_bytes(), 0).await;
    let uuid: String = out.buf[at + prefix.len()..]
        .iter()
        .take_while(|b| b.is_ascii_hexdigit() || **b == b'-')
        .map(|b| char::from(*b))
        .collect();
    assert_eq!(uuid.len(), 36, "init-script path not a UUID path: {uuid:?}");
    let init_path = format!("{INIT_SCRIPT_PREFIX}{uuid}");
    let notice = b"# [termiHub] Shell integration: setting up OSC 7 CWD tracking";
    let after_notice = out.wait_for(notice, at).await;

    // 2. The hook from the sourced file is installed in the live shell.
    wsl.write(b"echo \"HOOK_$(type -t __termihub_osc7)_END\"\n")
        .expect("write");
    out.wait_for(b"HOOK_function_END", after_notice).await;

    // 3. The script removed itself after being sourced.
    let probe =
        format!("echo \"PROBE$((40+2))_$(test -e {init_path} && echo present || echo absent)\"\n");
    wsl.write(probe.as_bytes()).expect("write");
    let (which, after_probe) = out
        .wait_any(&[b"PROBE42_absent", b"PROBE42_present"], after_notice)
        .await;
    assert_eq!(which, 0, "init script {init_path} was not self-cleaned");

    // 4. CWD tracking: a `cd` produces an OSC 7 for the new directory.
    wsl.write(b"cd /usr/share\n").expect("write");
    out.wait_for(b"\x1b]7;file:///usr/share\x07", after_probe)
        .await;

    // 5. The setup body itself never reached the terminal (no direct injection).
    let text = out.text();
    assert!(
        !text.contains("__termihub_osc7(){"),
        "setup body was visible in the terminal (direct-injection fallback?):\n{text:?}"
    );

    wsl.disconnect().await.expect("disconnect");
}

/// Prefix of every per-session init-script path.
const INIT_SCRIPT_PREFIX: &str = super::super::wsl_init_script::INIT_SCRIPT_PATH_PREFIX;

// ---------------------------------------------------------------------------
// #3567 — queued Windows <-> WSL folder copy through the local transfer queue
// ---------------------------------------------------------------------------

#[cfg(feature = "local-transfer")]
mod queued_copy {
    use std::path::Path;
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::files::transfer::local::{
        partial_path, DIRECT_COPY_MAX_BYTES, LOCAL_TRANSFER_SESSION,
    };
    use crate::files::transfer::local_folder::{
        lay_out_folder_copy, plan_folder_copy, run_local_transfer_in_group, FolderCopyLimits,
    };
    use crate::files::transfer::{
        ProgressSink, TransferDirection, TransferPhase, TransferProgress, TransferRegistry,
        TransferStateTag,
    };

    /// Deterministic, non-repeating-per-chunk test content.
    fn content(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    /// Copy the folder `src` to `dest` the way the desktop's folder paste does:
    /// plan, lay out (small files directly), then run every large file through
    /// the queue. Asserts the large file really was queued and completed.
    async fn queued_folder_copy(src: &Path, dest: &Path) {
        let plan = plan_folder_copy(src, &FolderCopyLimits::default()).expect("plan");
        assert_eq!(
            plan.queued.len(),
            1,
            "the big file must go through the queue"
        );
        lay_out_folder_copy(src, dest, &plan).expect("lay out");

        let registry = TransferRegistry::new();
        let ids: Vec<String> = (0..plan.queued.len())
            .map(|_| uuid::Uuid::new_v4().to_string())
            .collect();
        let group: Arc<[String]> = ids.iter().cloned().collect();
        for (file, id) in plan.queued.iter().zip(&ids) {
            let from = src.join(&file.rel).to_string_lossy().into_owned();
            let to = dest.join(&file.rel).to_string_lossy().into_owned();
            let handle = registry.enqueue(
                id,
                LOCAL_TRANSFER_SESSION,
                TransferDirection::Download,
                "big.bin",
                &to,
                file.size,
            );
            let phases = Arc::new(Mutex::new(Vec::new()));
            let rec = phases.clone();
            let sink: ProgressSink = Arc::new(move |p: &TransferProgress| {
                rec.lock().expect("lock").push(p.phase);
            });
            run_local_transfer_in_group(
                from,
                to.clone(),
                handle.clone(),
                registry.clone(),
                sink,
                group.clone(),
                0,
            )
            .await;
            assert_eq!(
                handle.state().tag(),
                TransferStateTag::Completed,
                "queued copy to {to} did not complete: {:?}",
                handle.snapshot()
            );
            assert_eq!(handle.snapshot().transferred, file.size);
            assert_eq!(
                phases.lock().expect("lock").last(),
                Some(&TransferPhase::Done)
            );
            assert!(
                !partial_path(&to, id).exists(),
                "temp file left behind for {to}"
            );
        }
    }

    #[tokio::test]
    async fn live_wsl_queued_folder_copy_round_trips_windows_and_wsl() {
        let Some(distro) = live_distro() else {
            return;
        };
        let _alive = KeepAlive::start(&distro);
        let scratch = Scratch::new(&distro);

        let win = tempfile::tempdir().expect("tempdir");
        let src = win.path().join("src");
        std::fs::create_dir_all(src.join("nested")).expect("mkdir");
        std::fs::write(src.join("small.txt"), b"small file").expect("write");
        let big = content(usize::try_from(DIRECT_COPY_MAX_BYTES).expect("fits") + 4097);
        std::fs::write(src.join("nested/big.bin"), &big).expect("write");

        // Windows -> WSL, through the `//wsl$/<distro>/…` path the frontend uses.
        let wsl_dest = format!("//wsl$/{distro}{}/copy", scratch.path);
        queued_folder_copy(&src, Path::new(&wsl_dest)).await;

        // Verify from inside the distribution, not back over the same share.
        let linux_copy = format!("{}/copy", scratch.path);
        let small = wsl_ok(&distro, "cat \"$1/small.txt\"", &[&linux_copy]);
        assert_eq!(small, b"small file");
        let copied = wsl_ok(&distro, "cat \"$1/nested/big.bin\"", &[&linux_copy]);
        assert!(
            copied == big,
            "big file corrupted on the Windows -> WSL copy"
        );

        // WSL -> Windows.
        let back = win.path().join("back");
        queued_folder_copy(Path::new(&wsl_dest), &back).await;
        assert_eq!(
            std::fs::read(back.join("small.txt")).expect("read"),
            b"small file"
        );
        let returned = std::fs::read(back.join("nested").join("big.bin")).expect("read");
        assert!(
            returned == big,
            "big file corrupted on the WSL -> Windows copy"
        );
    }
}

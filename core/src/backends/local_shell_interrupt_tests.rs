//! Real-PTY tests for [`ConnectionType::interrupt_io`] on the local shell
//! (#4394).
//!
//! A tab close must not leave the child and its PTY behind when a write is
//! parked because the foreground program never reads stdin again. These
//! spawn a real child on a real PTY (via [`NativeLocalShellSpawner`]) that
//! never reads its input, fill the PTY input queue until a write parks, and
//! prove that `interrupt_io` makes that write return and the child exit.
//!
//! Unix only: the Windows ConPTY path is argued in the `interrupt_io` docs
//! (the console host drains the input pipe itself, so a parked write there
//! needs the host to stop reading — not something a test can stage).
//!
//! Every wait polls its condition and returns as soon as it holds; the
//! ceilings only bound a hang, so they are generous.

use super::*;
use std::sync::atomic::AtomicU64;
use std::time::{Duration, Instant};

/// Upper bound for one wait. Conditions usually hold within milliseconds.
const CEILING: Duration = Duration::from_secs(20);

/// How long the written-byte counter must stay flat before the writer is
/// considered parked inside `write`.
const PARKED_FOR: Duration = Duration::from_millis(300);

/// Spawns `sh -c 'exec sleep 120'` on a real PTY, whatever command
/// `LocalShell::connect` built: a foreground program that never reads stdin.
struct NonReadingChildSpawner {
    pid: Arc<Mutex<Option<u32>>>,
}

impl LocalShellSpawner for NonReadingChildSpawner {
    fn spawn(
        &self,
        command: &crate::session::shell::ShellCommand,
    ) -> Result<SpawnedShell, SessionError> {
        let mut command = command.clone();
        command.program = "/bin/sh".to_string();
        command.args = vec![
            "-c".to_string(),
            "echo $$ > \"$PID_FILE\"; exec sleep 120".to_string(),
        ];
        let pid_file = std::env::temp_dir().join(format!(
            "termihub-4394-{}-{}.pid",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        command
            .env
            .insert("PID_FILE".to_string(), pid_file.display().to_string());
        let spawned = NativeLocalShellSpawner.spawn(&command)?;
        let deadline = Instant::now() + CEILING;
        let pid = loop {
            if let Some(pid) = std::fs::read_to_string(&pid_file)
                .ok()
                .and_then(|s| s.trim().parse::<u32>().ok())
            {
                break pid;
            }
            assert!(Instant::now() < deadline, "child never wrote its pid");
            std::thread::sleep(Duration::from_millis(10));
        };
        let _ = std::fs::remove_file(&pid_file);
        *self.pid.lock().unwrap() = Some(pid);
        Ok(spawned)
    }
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// `true` while a process with `pid` exists (signal 0 probes without
/// signalling). A zombie still counts; the watcher thread reaps the child.
fn process_exists(pid: u32) -> bool {
    // SAFETY: `kill` with signal 0 only checks for existence/permission.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + CEILING;
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for: {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn interrupt_io_unparks_a_stalled_pty_write_and_ends_the_child() {
    let pid = Arc::new(Mutex::new(None));
    let mut shell = LocalShell::with_spawner(NonReadingChildSpawner { pid: pid.clone() });
    shell
        .connect(serde_json::json!({ "shell": "sh", "shellIntegration": false }))
        .await
        .expect("connect");
    let pid = pid.lock().unwrap().expect("child pid");
    let shell = Arc::new(shell);

    // Write until the PTY input queue is full and `write` parks.
    let written = Arc::new(AtomicU64::new(0));
    let (done_tx, done_rx) = std::sync::mpsc::channel::<Result<(), SessionError>>();
    let writer = {
        let shell = shell.clone();
        let written = written.clone();
        std::thread::spawn(move || {
            // Whole lines: a canonical-mode tty discards input past
            // MAX_INPUT on an unterminated line (macOS) instead of blocking
            // the writer, but completed lines queue until the queue is full.
            let mut chunk = [b'x'; 1024];
            for line_end in chunk.iter_mut().skip(63).step_by(64) {
                *line_end = b'\n';
            }
            let result = loop {
                if let Err(e) = shell.write(&chunk) {
                    break Err(e);
                }
                written.fetch_add(chunk.len() as u64, Ordering::SeqCst);
            };
            let _ = done_tx.send(result);
        })
    };

    // Parked: the counter stops moving while the writer thread is still busy.
    let deadline = Instant::now() + CEILING;
    let mut last = written.load(Ordering::SeqCst);
    let mut flat_since = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(20));
        let now = written.load(Ordering::SeqCst);
        if now != last {
            last = now;
            flat_since = Instant::now();
        } else if flat_since.elapsed() >= PARKED_FOR {
            break;
        }
        assert!(Instant::now() < deadline, "PTY write never parked");
    }
    assert!(
        done_rx.try_recv().is_err(),
        "the writer must be parked inside write(), not finished"
    );
    eprintln!("parked after {last} bytes");

    shell.interrupt_io();

    let result = done_rx
        .recv_timeout(CEILING)
        .expect("interrupt_io must make the parked write return");
    assert!(result.is_err(), "the interrupted write reports an error");
    writer.join().unwrap();
    wait_until("child process exits", || !process_exists(pid));
    assert!(!shell.is_connected());
}

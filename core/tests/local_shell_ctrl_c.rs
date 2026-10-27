#![cfg(all(windows, feature = "local-shell"))]
//! Ctrl+C interrupts a ConPTY child even when termiHub was started with
//! Ctrl+C disabled (#4981).
//!
//! Windows keeps a per-process "ignore Ctrl+C" attribute that every child
//! inherits. A launcher that spawns termiHub with `CREATE_NEW_PROCESS_GROUP`, or
//! that called `SetConsoleCtrlHandler(NULL, TRUE)`, hands it to termiHub, and
//! termiHub used to hand it on to every shell it hosted: a `\x03` written to the
//! pseudoconsole became a `CTRL_C_EVENT` that the foreground program ignored.
//! On the system-test runner a real Ctrl+C therefore never interrupted
//! `Start-Sleep 60` or `ping -n 60` in the default PowerShell tab.
//!
//! This binary sets that attribute on itself first, exactly as such a launcher
//! leaves it, then spawns `ping` through the production
//! [`NativeLocalShellSpawner`], writes `\x03` and requires `ping` to exit long
//! before its own run would end. The attribute is process-wide, which is why
//! this is a test binary of its own with a single test.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use termihub_core::backends::local_shell::NativeLocalShellSpawner;
use termihub_core::session::shell::ShellCommand;
use termihub_core::session::traits::LocalShellSpawner;

/// How many echo requests `ping` sends: about one per second, so an
/// uninterrupted run lasts this many seconds less one.
const PINGS: u32 = 30;

/// How long `ping` may take to start printing.
const START_DEADLINE: Duration = Duration::from_secs(30);

/// How long `ping` may take to exit after the `\x03`. Far below the ~29 s an
/// uninterrupted run lasts; an interrupted one exits within a second.
const EXIT_DEADLINE: Duration = Duration::from_secs(10);

#[test]
fn ctrl_c_interrupts_a_conpty_child_when_the_app_ignores_ctrl_c() {
    use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
    // SAFETY: a plain Win32 call that sets this process's ignore-Ctrl+C
    // attribute, as a `CREATE_NEW_PROCESS_GROUP` launcher leaves it.
    assert_ne!(
        unsafe { SetConsoleCtrlHandler(None, 1) },
        0,
        "set the ignore-Ctrl+C attribute: {}",
        std::io::Error::last_os_error()
    );

    let command = ShellCommand {
        program: "ping.exe".to_string(),
        args: vec!["-n".into(), PINGS.to_string(), "127.0.0.1".into()],
        env: HashMap::new(),
        cwd: None,
        cols: 120,
        rows: 30,
    };
    let spawned = NativeLocalShellSpawner
        .spawn(&command)
        .expect("spawn ping on a ConPTY");

    // Drain the output: the console host stalls a child whose output nobody
    // reads, and the first lines show that ping is running.
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
    let mut reader = spawned.reader;
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => {
                    if out_tx.send(buf[..n].to_vec()).is_err() {
                        return;
                    }
                }
            }
        }
    });
    let (exit_tx, exit_rx) = mpsc::channel::<()>();
    let wait_for_exit = spawned.wait_for_exit;
    std::thread::spawn(move || {
        wait_for_exit();
        let _ = exit_tx.send(());
    });

    // Wait until ping has printed its first reply line: by then its console
    // control handler is installed. The address appears in the banner and in
    // every reply, whatever the system language.
    let mut output = Vec::new();
    let started = Instant::now();
    while count(&output, b"127.0.0.1") < 2 {
        let left = START_DEADLINE.saturating_sub(started.elapsed());
        match out_rx.recv_timeout(left) {
            Ok(chunk) => output.extend_from_slice(&chunk),
            Err(_) => {
                (spawned.kill)();
                panic!(
                    "ping printed no reply within {START_DEADLINE:?}; got: {}",
                    String::from_utf8_lossy(&output).escape_debug()
                );
            }
        }
    }

    let mut writer = spawned.writer;
    writer.write_all(b"\x03").expect("write Ctrl+C");
    writer.flush().expect("flush Ctrl+C");
    let interrupted_at = Instant::now();

    let exited = exit_rx.recv_timeout(EXIT_DEADLINE).is_ok();
    let took = interrupted_at.elapsed();
    (spawned.kill)();
    (spawned.close_pty)();
    while let Ok(chunk) = out_rx.try_recv() {
        output.extend_from_slice(&chunk);
    }
    assert!(
        exited,
        "ping was still running {EXIT_DEADLINE:?} after the \\x03: it inherited this \
         process's ignore-Ctrl+C attribute, so the CTRL_C_EVENT the console host raised \
         was ignored (#4981); output: {}",
        String::from_utf8_lossy(&output).escape_debug()
    );
    eprintln!("ping exited {took:?} after the \\x03");
}

fn count(haystack: &[u8], needle: &[u8]) -> usize {
    haystack
        .windows(needle.len())
        .filter(|w| *w == needle)
        .count()
}

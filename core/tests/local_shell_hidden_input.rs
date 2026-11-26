#![cfg(all(unix, feature = "local-shell"))]
//! A local program that reads with its echo off is recognised from the PTY
//! (#6014), not only from the words of its prompt: the recorder leaves out what
//! is typed there, and a Continue does not go on past it.
//!
//! The PTY master reports its slave's settings: canonical mode (`ICANON`) with
//! `ECHO` off is a program reading a hidden line (`read -s`, `getpass`, `stty
//! -echo`). This spawns `/bin/sh` through the production
//! [`NativeLocalShellSpawner`] on a real PTY and asks at an unusual prompt
//! ("Enter code: ") that no word list knows, then at an ordinary one.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use termihub_core::backends::local_shell::NativeLocalShellSpawner;
use termihub_core::session::shell::ShellCommand;
use termihub_core::session::traits::LocalShellSpawner;

const DEADLINE: Duration = Duration::from_secs(20);

/// Wait until `output` holds `text`, reading from `rx`.
fn wait_for(rx: &mpsc::Receiver<Vec<u8>>, output: &mut Vec<u8>, text: &str) {
    let started = Instant::now();
    while !String::from_utf8_lossy(output).contains(text) {
        let left = DEADLINE.saturating_sub(started.elapsed());
        match rx.recv_timeout(left) {
            Ok(chunk) => output.extend_from_slice(&chunk),
            Err(_) => panic!(
                "{text:?} never came; got {}",
                String::from_utf8_lossy(output).escape_debug()
            ),
        }
    }
}

/// Poll `probe` until it answers `want`.
fn until(probe: &dyn Fn() -> bool, want: bool, what: &str) {
    let started = Instant::now();
    while probe() != want {
        assert!(started.elapsed() < DEADLINE, "never {want}: {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn a_program_reading_with_echo_off_is_seen_on_the_pty() {
    // Then a key read raw with echo off, as a line editor reads at the shell's
    // prompt: that is no hidden line, or every prompt would count as a password.
    let script = concat!(
        "stty -echo; printf 'Enter code: '; read x; stty echo; ",
        "printf '\\nName: '; read y; ",
        "stty -icanon -echo min 1; printf 'Key: '; dd bs=1 count=1 2>/dev/null >/dev/null; ",
        "stty icanon echo; printf 'done\\n'"
    );
    let command = ShellCommand {
        program: "/bin/sh".to_string(),
        args: vec!["-c".into(), script.into()],
        env: HashMap::new(),
        cwd: None,
        cols: 80,
        rows: 24,
    };
    let spawned = NativeLocalShellSpawner
        .spawn(&command)
        .expect("spawn /bin/sh on a PTY");
    let hidden = spawned
        .hidden_input
        .expect("a local PTY can tell whether input is hidden");

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
    let mut output = Vec::new();
    let mut writer = spawned.writer;

    // An unusual prompt, with echo off: hidden.
    wait_for(&rx, &mut output, "Enter code: ");
    until(&*hidden, true, "the code is read with echo off");
    writer.write_all(b"s3cret\n").expect("type the code");
    writer.flush().expect("flush");

    // An ordinary question, with echo on again: not hidden.
    wait_for(&rx, &mut output, "Name: ");
    until(&*hidden, false, "the name is read with echo on");
    assert!(
        !String::from_utf8_lossy(&output).contains("s3cret"),
        "the hidden answer was echoed"
    );
    writer.write_all(b"ana\n").expect("type the name");
    writer.flush().expect("flush");

    // Raw mode with echo off, as a line editor: not hidden.
    wait_for(&rx, &mut output, "Key: ");
    std::thread::sleep(Duration::from_millis(200));
    assert!(
        !hidden(),
        "a raw read with echo off counted as hidden input"
    );
    writer.write_all(b"k").expect("press a key");
    writer.flush().expect("flush");
    wait_for(&rx, &mut output, "done");
    (spawned.kill)();
}

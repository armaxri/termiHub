//! Resize, then type a line: does every byte reach the shell? (#6078)
//!
//! On the Windows lanes the first character of a line typed shortly after a
//! terminal resize was lost twice in one nightly, in an MSYS2 bash, over SSH
//! (Win32-OpenSSH) and in a local ConPTY session. Our write path is ruled out
//! for SSH (`ssh_input_after_resize.rs`, #6074) and a local shell gets one
//! `write_all` of the whole line, so what is left is ConPTY and the MSYS2
//! (Cygwin) console.
//!
//! [`run_rounds`] measures it: for each kind of resize (rows only, columns
//! only) and each wait between the resize and the input (0, 100, 300 and
//! 1000 ms), `rounds` times: resize, wait, type `echo QX<marker>` with Enter,
//! and read what the shell did with it. A line the shell ran prints its
//! marker; a line that lost bytes runs a command bash does not know
//! (`bash: cho: command not found`), which names exactly what arrived. Every
//! round records how long our resize call took, how long after it the input
//! was written, how long the write took, and when the first output after the
//! write arrived. [`Report`] prints one line per round and a summary per kind
//! and wait, so one run says:
//!
//! - losses only right after a resize, and fewer the longer the wait: the
//!   shell's console loses input around a resize (ConPTY or the Cygwin
//!   console; compare the local and the SSH session and the two bashes);
//! - losses whatever the wait: not about the resize;
//! - no losses here but in the app: the app's own ordering (the frontend's
//!   hold after a resize, `shellRedrawWait.ts`), not the PTY.
//!
//! Opt-in (`TERMIHUB_RESIZE_INPUT_REPRO=1`): the Windows SSH Host lane runs it,
//! `TERMIHUB_RESIZE_INPUT_ROUNDS` sets the rounds (default 10).

use std::fmt::Write as _;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The env var that turns the repro on.
pub const ENABLE_ENV: &str = "TERMIHUB_RESIZE_INPUT_REPRO";
/// The env var that sets the rounds per kind and wait.
pub const ROUNDS_ENV: &str = "TERMIHUB_RESIZE_INPUT_ROUNDS";

/// The waits between the resize and the input, in ms.
pub const WAITS_MS: [u64; 4] = [0, 100, 300, 1000];

/// How long a round waits for the shell to answer the line.
const ANSWER_DEADLINE: Duration = Duration::from_secs(10);

/// Whether the repro runs, and how many rounds; `None` when it is off.
pub fn enabled_rounds() -> Option<usize> {
    if std::env::var(ENABLE_ENV).ok().as_deref() != Some("1") {
        eprintln!("SKIPPED: set {ENABLE_ENV}=1 to run the resize-then-type repro (#6078)");
        return None;
    }
    Some(
        std::env::var(ROUNDS_ENV)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(10),
    )
}

/// The output of a session, with the time each chunk arrived.
#[derive(Clone, Default)]
pub struct Output(Arc<Mutex<Vec<Chunk>>>);

/// When a chunk of output arrived, and its bytes.
type Chunk = (Instant, Vec<u8>);

impl Output {
    /// Record a chunk the session printed.
    pub fn push(&self, chunk: &[u8]) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((Instant::now(), chunk.to_vec()));
    }

    fn len(&self) -> usize {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// The text printed since chunk `from`, and when its first chunk at or
    /// after `after` arrived.
    fn since(&self, from: usize, after: Instant) -> (String, Option<Instant>) {
        let chunks = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut text = Vec::new();
        let mut first = None;
        for (at, chunk) in chunks.iter().skip(from) {
            if first.is_none() && *at >= after {
                first = Some(*at);
            }
            text.extend_from_slice(chunk);
        }
        (String::from_utf8_lossy(&text).into_owned(), first)
    }
}

/// What a resize changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResizeKind {
    Rows,
    Cols,
}

/// What the shell did with a typed line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// It ran the line: every byte arrived.
    Ran,
    /// It ran a command it does not know, named `word`: bytes were lost.
    Lost { word: String },
    /// No answer within the deadline.
    Silent,
}

/// What the shell did with `echo QX<marker>`, from its output `text`.
pub fn verdict(text: &str, marker: &str) -> Verdict {
    let printed = format!("QX{marker}");
    // The shell names what arrived when it does not know the command.
    for line in text.split(['\r', '\n']) {
        let line = strip_csi(line);
        let line = line.trim_end();
        // bash: `bash: cho: command not found`.
        if let Some(head) = line.strip_suffix(": command not found") {
            let word = head.rsplit(": ").next().unwrap_or(head).to_owned();
            return Verdict::Lost { word };
        }
        // zsh: `zsh: command not found: cho`.
        if let Some((_, word)) = line.split_once("command not found: ") {
            return Verdict::Lost {
                word: word.to_owned(),
            };
        }
    }
    // The typed line echoed, then its output on a line of its own.
    let ran = text.split(['\r', '\n']).any(|line| {
        let line = strip_csi(line);
        line.trim_end() == printed
    });
    if ran {
        Verdict::Ran
    } else {
        Verdict::Silent
    }
}

/// `line` without ANSI CSI sequences (a prompt's colours, a redraw).
fn strip_csi(line: &str) -> String {
    let mut out = String::new();
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() || c == '~' {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// One round's measurements.
#[derive(Debug, Clone)]
pub struct Round {
    pub kind: ResizeKind,
    pub wait_ms: u64,
    pub round: usize,
    /// How long our resize call took.
    pub resize_ms: f64,
    /// From the resize call's return to the input write's start.
    pub resize_to_write_ms: f64,
    /// How long our write call took.
    pub write_ms: f64,
    /// From the write's start to the first output after it.
    pub first_output_ms: Option<f64>,
    pub verdict: Verdict,
    /// The output of a round that did not run its line.
    pub output: String,
}

/// All rounds of one session.
#[derive(Debug, Default)]
pub struct Report {
    pub label: String,
    pub rounds: Vec<Round>,
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

impl Report {
    /// One line per round, the output of every round that lost bytes, and a
    /// summary per kind and wait.
    pub fn render(&self) -> String {
        let mut s = format!("== resize then type (#6078): {}\n", self.label);
        let _ = writeln!(
            s,
            "kind  wait  round  resize_ms  resize->write_ms  write_ms  first_output_ms  verdict"
        );
        for r in &self.rounds {
            let _ = writeln!(
                s,
                "{:<5} {:>4}  {:>5}  {:>9.2}  {:>16.2}  {:>8.2}  {:>15}  {:?}",
                format!("{:?}", r.kind),
                r.wait_ms,
                r.round,
                r.resize_ms,
                r.resize_to_write_ms,
                r.write_ms,
                r.first_output_ms
                    .map_or("-".to_owned(), |v| format!("{v:.2}")),
                r.verdict
            );
            if r.verdict != Verdict::Ran {
                let _ = writeln!(s, "      output: {:?}", r.output);
            }
        }
        for kind in [ResizeKind::Rows, ResizeKind::Cols] {
            for wait in WAITS_MS {
                let of: Vec<&Round> = self
                    .rounds
                    .iter()
                    .filter(|r| r.kind == kind && r.wait_ms == wait)
                    .collect();
                let lost = of
                    .iter()
                    .filter(|r| matches!(r.verdict, Verdict::Lost { .. }))
                    .count();
                let silent = of.iter().filter(|r| r.verdict == Verdict::Silent).count();
                let _ = writeln!(
                    s,
                    "summary {:?} wait {wait} ms: {lost} lost, {silent} silent of {}",
                    kind,
                    of.len()
                );
            }
        }
        s
    }

    /// The rounds that did not run their line whole.
    pub fn failures(&self) -> Vec<&Round> {
        self.rounds
            .iter()
            .filter(|r| r.verdict != Verdict::Ran)
            .collect()
    }
}

/// A session to measure: how to write to it and how to resize it.
pub struct Session<'a> {
    pub write: &'a dyn Fn(&[u8]),
    pub resize: &'a dyn Fn(u16, u16),
    pub output: Output,
    /// What ends a typed line: CR, as the terminal sends Enter.
    pub enter: &'a str,
}

/// Wait until the shell answers `echo QXready` (it is up and reading).
pub fn wait_ready(session: &Session<'_>) -> bool {
    let from = session.output.len();
    (session.write)(format!("echo QXready{}", session.enter).as_bytes());
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        let (text, _) = session.output.since(from, Instant::now());
        if verdict(&text, "ready") == Verdict::Ran {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

/// Run the rounds: see the module doc. Starts from 120x30.
pub fn run_rounds(label: &str, session: &Session<'_>, rounds: usize) -> Report {
    let mut report = Report {
        label: label.to_owned(),
        ..Report::default()
    };
    let (mut cols, mut rows) = (120u16, 30u16);
    for kind in [ResizeKind::Rows, ResizeKind::Cols] {
        for wait_ms in WAITS_MS {
            for round in 0..rounds {
                match kind {
                    ResizeKind::Rows => rows = if rows == 30 { 31 } else { 30 },
                    ResizeKind::Cols => cols = if cols == 120 { 121 } else { 120 },
                }
                let marker = format!(
                    "{}{wait_ms}x{round}",
                    if kind == ResizeKind::Rows { "r" } else { "c" }
                );
                let from = session.output.len();
                let t0 = Instant::now();
                (session.resize)(cols, rows);
                let t1 = Instant::now();
                std::thread::sleep(Duration::from_millis(wait_ms));
                let t2 = Instant::now();
                (session.write)(format!("echo QX{marker}{}", session.enter).as_bytes());
                let t3 = Instant::now();
                let deadline = t3 + ANSWER_DEADLINE;
                let (verdict, text, first) = loop {
                    let (text, first) = session.output.since(from, t2);
                    let v = verdict(&text, &marker);
                    if v != Verdict::Silent || Instant::now() >= deadline {
                        break (v, text, first);
                    }
                    std::thread::sleep(Duration::from_millis(10));
                };
                report.rounds.push(Round {
                    kind,
                    wait_ms,
                    round,
                    resize_ms: ms(t1 - t0),
                    resize_to_write_ms: ms(t2 - t1),
                    write_ms: ms(t3 - t2),
                    first_output_ms: first.map(|f| ms(f.saturating_duration_since(t2))),
                    output: if verdict == Verdict::Ran {
                        String::new()
                    } else {
                        text
                    },
                    verdict,
                });
            }
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_that_ran_prints_its_marker_on_a_line_of_its_own() {
        let text = "$ echo QXr0x1\r\nQXr0x1\r\n$ ";
        assert_eq!(verdict(text, "r0x1"), Verdict::Ran);
        // Coloured output and a redraw around it.
        let text = "\x1b[?2004l\r\x1b[KQXr0x1\x1b[0m\r\n";
        assert_eq!(verdict(text, "r0x1"), Verdict::Ran);
    }

    #[test]
    fn a_lost_first_byte_names_what_arrived() {
        let text = "$ cho QXr0x1\r\nbash: cho: command not found\r\n$ ";
        assert_eq!(verdict(text, "r0x1"), Verdict::Lost { word: "cho".into() });
        let text = "eho QXc100x3\r\n/usr/bin/bash: eho: command not found\r\n";
        assert_eq!(
            verdict(text, "c100x3"),
            Verdict::Lost { word: "eho".into() }
        );
    }

    #[test]
    fn a_zsh_login_shell_names_it_the_other_way_round() {
        let text = "% cho QXr0x1\r\nzsh: command not found: cho\r\n";
        assert_eq!(verdict(text, "r0x1"), Verdict::Lost { word: "cho".into() });
    }

    /// A shell stand-in that loses the first byte of a line typed within
    /// `window` of a resize, as the nightly saw (#6078).
    #[test]
    fn a_run_reports_each_lost_byte_with_its_kind_and_wait() {
        use std::sync::atomic::{AtomicU64, Ordering};
        let output = Output::default();
        let sink = output.clone();
        let resized_at = Mutex::new(Instant::now());
        let window = Duration::from_millis(50);
        let lost = AtomicU64::new(0);
        let write = |data: &[u8]| {
            let line = String::from_utf8_lossy(data).trim_end().to_owned();
            let recent = resized_at.lock().unwrap().elapsed() < window;
            let typed = if recent && line != "echo QXready" {
                lost.fetch_add(1, Ordering::SeqCst);
                line[1..].to_owned()
            } else {
                line
            };
            let answer = match typed.strip_prefix("echo ") {
                Some(rest) => format!("$ {typed}\r\n{rest}\r\n"),
                None => {
                    let word = typed.split(' ').next().unwrap_or("");
                    format!("$ {typed}\r\nbash: {word}: command not found\r\n")
                }
            };
            sink.push(answer.as_bytes());
        };
        let resize = |_: u16, _: u16| *resized_at.lock().unwrap() = Instant::now();
        let session = Session {
            write: &write,
            resize: &resize,
            output,
            enter: "\r",
        };
        assert!(wait_ready(&session));
        let report = run_rounds("stand-in", &session, 1);
        let failures = report.failures();
        // Only the rounds typed right after the resize lost their first byte.
        assert_eq!(failures.len() as u64, lost.load(Ordering::SeqCst));
        assert!(!failures.is_empty());
        assert!(failures
            .iter()
            .all(|r| r.wait_ms == 0 && r.verdict == Verdict::Lost { word: "cho".into() }));
        let rendered = report.render();
        assert!(
            rendered.contains("summary Rows wait 0 ms: 1 lost, 0 silent of 1"),
            "{rendered}"
        );
        assert!(
            rendered.contains("summary Rows wait 1000 ms: 0 lost, 0 silent of 1"),
            "{rendered}"
        );
        assert!(
            rendered.contains("bash: cho: command not found"),
            "{rendered}"
        );
    }

    #[test]
    fn only_the_echo_of_the_typed_line_is_not_an_answer() {
        assert_eq!(verdict("$ echo QXr0x1", "r0x1"), Verdict::Silent);
        // Another round's marker is not this one's.
        assert_eq!(verdict("QXr0x10\r\n", "r0x1"), Verdict::Silent);
    }
}

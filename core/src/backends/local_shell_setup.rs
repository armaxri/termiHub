//! Typing the shell-integration setup into a local bash / zsh without it
//! showing (#5009).
//!
//! bash and zsh login shells take no startup argument that could carry the
//! setup, so it is typed into the shell. Two things keep it off the screen:
//!
//! 1. **Typed at the prompt, not at spawn.** Typed while the shell is still
//!    starting, the kernel's cooked-mode tty echoes the line at once — ahead
//!    of the rc output — and the line editor echoes it again later. So the
//!    line waits until the line editor is reading (the PTY left canonical
//!    mode; see `line_editor_reading`), bounded by [`READY_CAP`]. Input the
//!    user types before that sends the setup first, so it never splits or
//!    swallows their command.
//! 2. **Its echo is filtered out.** At the moment the line is typed, a
//!    [`SetupEchoFilter`] is armed on the output; it removes the echo up to
//!    the setup's own end mark, and shows everything as-is when the held
//!    output is anything else (see its module docs).
//!
//! Without a line-editor probe (Windows ConPTY, test doubles) the setup is
//! typed at once and shown: dropping ConPTY output would desynchronise its
//! screen model from the terminal. A bash on Windows is therefore handed the
//! setup through its environment instead (#5014); the line is then only the
//! fallback, typed when the shell's output shows the setup never ran (see
//! [`PromptWatch`]).

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tracing::{debug, warn};

use super::local_shell_setup_watch::{PromptWatch, Verdict};
use crate::connection::{OutputSender, PromptProbe};
use crate::output::setup_echo::{HideOutcome, SetupEchoFilter};

/// Upper bound on waiting for the line editor before typing the setup anyway.
pub(crate) const READY_CAP: Duration = Duration::from_secs(10);

/// How often the line-editor probe is polled.
const READY_POLL: Duration = Duration::from_millis(10);

type Writer = Arc<Mutex<Box<dyn Write + Send>>>;
type SenderSlot = Arc<Mutex<Option<OutputSender>>>;

struct State {
    /// The setup line, until it has been typed.
    pending: Option<Vec<u8>>,
    filter: SetupEchoFilter,
    /// Set when the shell got the setup through its environment: the line
    /// is typed only if this sees that the setup did not run.
    watch: Option<PromptWatch>,
}

/// One session's typed setup: when to type it, and hiding its echo.
pub(crate) struct TypedSetup {
    state: Mutex<State>,
    /// Whether to hide the echo (only where the line editor is observable).
    hide: bool,
    /// Set once the filter has nothing more to do (or never will), so the
    /// reader skips the lock from then on. Until then every chunk goes
    /// through the filter, which also remembers the first prompt.
    bypass: AtomicBool,
    /// Whether output still goes to the [`PromptWatch`].
    watching: AtomicBool,
    writer: Writer,
    output_tx: SenderSlot,
}

impl TypedSetup {
    /// Prepare `line` (without its newline) to be typed into the shell.
    /// `bootstrapped`: the shell was also handed the setup through its
    /// environment, so the line is only typed if that does not run.
    pub(crate) fn new(
        line: &str,
        hide: bool,
        bootstrapped: bool,
        writer: Writer,
        output_tx: SenderSlot,
    ) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                pending: Some(format!("{line}\n").into_bytes()),
                filter: SetupEchoFilter::new(),
                watch: bootstrapped.then(|| PromptWatch::new(Instant::now())),
            }),
            hide,
            bypass: AtomicBool::new(!hide),
            watching: AtomicBool::new(bootstrapped),
            writer,
            output_tx,
        })
    }

    /// Type the setup now, unless it already was. Arms the filter first, so
    /// no byte of the echo can pass before it is watching.
    pub(crate) fn type_now(self: &Arc<Self>) {
        let line = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            let Some(line) = state.pending.take() else {
                return;
            };
            if self.hide {
                state.filter.arm(&line, Instant::now());
                let this = self.clone();
                std::thread::spawn(move || this.run_timer());
            }
            line
        };
        // Written outside the state lock: a full PTY input queue must not
        // stall the reader, which needs that lock to drain the shell's output.
        let result = self.writer.lock().map(|mut w| {
            w.write_all(&line)?;
            w.flush()
        });
        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => warn!(error = %e, "failed to type the shell-integration setup"),
            Err(_) => warn!("failed to type the shell-integration setup: writer lock poisoned"),
        }
    }

    /// Type the setup once the line editor reads (`reading`), or at
    /// [`READY_CAP`]; gives up when the session ends (`alive` cleared).
    pub(crate) fn type_when_ready(self: Arc<Self>, reading: PromptProbe, alive: Arc<AtomicBool>) {
        std::thread::spawn(move || {
            let start = Instant::now();
            loop {
                if !alive.load(Ordering::SeqCst) || !self.is_pending() {
                    return;
                }
                if reading() {
                    debug!(waited = ?start.elapsed(), "line editor ready; typing the setup");
                    break;
                }
                if start.elapsed() >= READY_CAP {
                    debug!("no line editor seen; typing the setup anyway");
                    break;
                }
                std::thread::sleep(READY_POLL);
            }
            self.type_now();
        });
    }

    /// Before the user's input: a typed setup goes first, so it never splits
    /// or swallows their command. A bootstrapped one runs at the prompt by
    /// itself, so nothing is typed for it here.
    pub(crate) fn before_input(self: &Arc<Self>) {
        if !self.watching.load(Ordering::SeqCst) {
            self.type_now();
        }
    }

    /// Bootstrapped setup: type the line only if the shell's output shows
    /// the setup did not run (see [`PromptWatch`]); gives up when the
    /// session ends (`alive` cleared).
    pub(crate) fn type_unless_bootstrapped(self: Arc<Self>, alive: Arc<AtomicBool>) {
        std::thread::spawn(move || loop {
            if !alive.load(Ordering::SeqCst) {
                return;
            }
            let verdict = match self.state.lock() {
                Ok(mut state) => {
                    let verdict = state
                        .watch
                        .as_ref()
                        .map_or(Verdict::Type, |w| w.verdict(Instant::now()));
                    if verdict == Verdict::Ran {
                        state.pending = None;
                    }
                    verdict
                }
                Err(_) => return,
            };
            match verdict {
                Verdict::Wait => std::thread::sleep(READY_POLL),
                Verdict::Ran => {
                    debug!("the shell ran the bootstrapped setup");
                    self.watching.store(false, Ordering::SeqCst);
                    return;
                }
                Verdict::Type => {
                    debug!("the bootstrapped setup did not run; typing it");
                    self.watching.store(false, Ordering::SeqCst);
                    self.type_now();
                    return;
                }
            }
        });
    }

    fn is_pending(&self) -> bool {
        self.state.lock().is_ok_and(|s| s.pending.is_some())
    }

    /// The terminal's width, so a wrapped first prompt is replaced whole
    /// (#5054). Set at spawn and on every resize.
    pub(crate) fn set_width(&self, cols: u16) {
        if let Ok(mut state) = self.state.lock() {
            state.filter.set_width(cols);
        }
    }

    /// Hand a chunk of shell output on to `sender`, through the filter until
    /// the hide is over. The send happens under the state lock then, so the
    /// timer thread's releases keep their order.
    pub(crate) fn forward(&self, data: Vec<u8>, sender: &OutputSender) {
        if self.watching.load(Ordering::SeqCst) {
            if let Ok(mut state) = self.state.lock() {
                if let Some(watch) = state.watch.as_mut() {
                    watch.feed(&data, Instant::now());
                }
            }
        }
        if self.bypass.load(Ordering::SeqCst) {
            let _ = sender.blocking_send(data);
            return;
        }
        let Ok(mut state) = self.state.lock() else {
            let _ = sender.blocking_send(data);
            return;
        };
        let out = state.filter.feed(&data, Instant::now());
        self.after_step(&mut state);
        if !out.is_empty() {
            let _ = sender.blocking_send(out);
        }
    }

    fn after_step(&self, state: &mut State) {
        if state.filter.outcome().is_some() && !state.filter.is_active() {
            self.bypass.store(true, Ordering::SeqCst);
        }
        if state.filter.take_finished() {
            match state.filter.outcome() {
                Some(HideOutcome::Hidden) | None => {}
                Some(outcome) => {
                    debug!(
                        ?outcome,
                        "the shell-integration setup was shown, not hidden"
                    )
                }
            }
        }
    }

    /// Release held output at the filter's deadlines until it is done.
    fn run_timer(self: Arc<Self>) {
        loop {
            let Some(due) = self
                .state
                .lock()
                .ok()
                .and_then(|s| s.filter.next_deadline())
            else {
                return;
            };
            let now = Instant::now();
            if due > now {
                std::thread::sleep(due - now);
            }
            let sender = match self.output_tx.lock() {
                Ok(guard) => guard.clone(),
                Err(_) => None,
            };
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            let out = state.filter.poll(Instant::now());
            self.after_step(&mut state);
            match sender {
                Some(sender) if !out.is_empty() => {
                    let _ = sender.blocking_send(out);
                }
                Some(_) => {}
                None => return,
            }
        }
    }
}

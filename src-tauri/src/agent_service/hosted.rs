//! What the desktop knows about the services it runs on agents (#6028, F-2,
//! F-3): one record for tunnels and file servers.
//!
//! An agent-hosted service is only "running" while its agent says so. The
//! records here keep the cases apart that the row must not mix up:
//!
//! - **Running**: the agent answered, and it runs there.
//! - **Not reachable**: the agent is offline or silent, or never answered the
//!   start. The service may still run there; only the agent can tell, and its
//!   next answer decides.
//! - **Stopping**: a stop the agent has not confirmed yet. It is kept until the
//!   agent does, so a stop pressed while the agent is gone wins when it is back.
//! - **Waiting**: an automatic start that cannot run yet. Bounded by
//!   [`WAIT_LIMIT`], ended by a stop, and never run anywhere else meanwhile.
//! - **Starting**: a start is under way. There is at most one per service, and
//!   a stop during it is honoured when it ends.
//!
//! Every transition takes the one lock, so a stop and an answer that race
//! cannot both win. Nothing here sends while holding it.
//!
//! After an app restart (#6051) nothing is known: what a service's stored agent
//! says decides. [`expect`](HostedServices::expect) asks it once the agent is
//! there; what still runs is taken over, unless the user stopped, moved or
//! deleted it meanwhile, which stops it there. Stops an agent has not confirmed
//! are kept on disk ([`stored`](HostedServices::stored)), so they are sent after
//! a restart too, also for a service that has no row any more.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use chrono::{DateTime, Local};
use serde_json::Value;

use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::errors::TerminalError;

/// How long an automatic start waits for its agent or the credential store.
pub const WAIT_LIMIT: Duration = Duration::from_secs(30 * 60);

/// How long a start that got no answer may still take effect on the agent. Only
/// after it does "does not run there" end the doubt.
pub const UNKNOWN_SETTLE: Duration = Duration::from_secs(30);

/// Bound of one `*.status` request, so one silent agent does not hold up the
/// rows of the others.
const STATUS_TIMEOUT: Duration = Duration::from_secs(5);

/// Bound of one `*.stop` request.
const STOP_TIMEOUT: Duration = Duration::from_secs(10);

/// Status requests in a row an agent may leave unanswered before its services
/// are not reachable.
const MISSES: u8 = 3;

/// What an agent's `*.status` answer says about one service.
#[derive(Debug, Clone, PartialEq)]
pub enum Reading<S> {
    Running(S),
    NotRunning,
    /// An answer this build cannot read says nothing.
    Unreadable,
}

/// The kind-specific half: tunnels or file servers.
pub trait HostedKind: Send + Sync + 'static {
    /// What the agent reports about a running one.
    type State: Clone + Send + 'static;

    /// What is known of service `id` while its agent has not been asked.
    fn unknown_state(id: &str) -> Self::State;
    /// The `*.stop` request for service `id`.
    fn stop_request(id: &str) -> (&'static str, Value);
    /// The `*.status` request for service `id`.
    fn status_request(id: &str) -> (&'static str, Value);
    /// Read a `*.status` answer; `last` is what was known before.
    fn read_status(id: &str, reply: &Value, last: &Self::State) -> Reading<Self::State>;
    /// Whether the row shows more than fresh numbers when `before` becomes
    /// `after`.
    fn is_news(before: &Self::State, after: &Self::State) -> bool;
}

/// What starts a service.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartedBy {
    /// The user. When it is not possible now, it is refused.
    User,
    /// The launch of the app, a connection, or a service that comes back. When
    /// it is not possible yet, it waits. It never undoes the user's stop.
    Itself,
    /// The end of a wait.
    Wait,
}

/// What an automatic start waits for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaitFor {
    Agent(String),
    CredentialStore,
}

/// Why a service is not reachable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Away {
    /// Its agent is not connected.
    Offline,
    /// Its agent is connected but does not answer.
    Silent,
    /// The agent never answered its start.
    StartUnanswered,
}

/// What the row of a service shows, when the records here decide it.
#[derive(Debug, Clone, PartialEq)]
pub enum View<S> {
    Starting,
    Running {
        agent_id: String,
        state: S,
    },
    NotReachable {
        agent_id: String,
        state: S,
        why: Away,
    },
    Stopping {
        agent_id: String,
    },
    Waiting {
        on: WaitFor,
        until: DateTime<Local>,
    },
}

/// Why a start was not begun.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Busy {
    Starting,
    Running,
}

/// The right to run one start, from [`HostedServices::begin`].
#[derive(Debug)]
#[must_use = "a start that is not finished blocks every later one"]
pub struct Ticket {
    id: String,
    seq: u64,
}

/// How a start ended.
#[derive(Debug)]
pub enum Outcome<S> {
    /// The agent runs it.
    Started { agent_id: String, state: S },
    /// The agent did not answer: it may run there.
    Unanswered { agent_id: String, state: S },
    /// It does not run on an agent because of this start.
    Failed,
}

/// What [`HostedServices::finish`] leaves to the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Finished {
    Done,
    /// A stop was pressed meanwhile and nothing runs.
    Stopped,
    /// A stop was pressed meanwhile: it must be stopped on this agent.
    StopThere(String),
}

/// What a stop found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopPlan {
    /// Nothing that runs on an agent.
    Nothing,
    /// An automatic start that had not begun; it never will.
    StoppedWaiting,
    /// A start under way; it stops what it started when it ends.
    StartWillStop,
    /// It must be stopped on this agent; the stop is owed until confirmed.
    StopThere(String),
}

/// One thing to ask an agent on a poll tick.
#[derive(Debug, Clone)]
pub struct Target<S> {
    id: String,
    agent_id: String,
    seq: u64,
    ask: Ask<S>,
}

#[derive(Debug, Clone)]
enum Ask<S> {
    Status(S),
    Stop,
    /// Whether a service stored to run there still does, after a restart.
    Find(S),
}

/// The answer to one [`Target`].
#[derive(Debug, Clone)]
pub struct Sample<S> {
    id: String,
    agent_id: String,
    seq: u64,
    stop: bool,
    find: bool,
    probe: Probe<S>,
}

#[derive(Debug, Clone, PartialEq)]
enum Probe<S> {
    /// The agent is not connected.
    Offline,
    /// The agent is connected and did not answer.
    NoAnswer,
    Running(S),
    /// It does not run there, or the stop is confirmed.
    NotRunning,
}

/// What a poll tick changed.
#[derive(Debug, Clone, PartialEq)]
pub enum Change {
    /// Still running. `news`: the row shows more than fresh numbers.
    Sampled { id: String, news: bool },
    /// Running or not reachable now, and it was the other before.
    Presence(String),
    /// Its agent answered that it does not run there. `unanswered`: after a
    /// start that got no answer, so it never ran.
    Gone {
        id: String,
        agent_id: String,
        unanswered: bool,
    },
    /// The agent confirmed a stop.
    Stopped(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Presence {
    Here,
    Away(Away),
}

struct Live<S> {
    agent_id: String,
    state: S,
    presence: Presence,
    /// Before it, "does not run there" does not end an unanswered start.
    settle_at: Option<Instant>,
    misses: u8,
    seq: u64,
}

struct Owed {
    seq: u64,
    /// Before it, a confirmed stop may still be overtaken by an unanswered start.
    settle_at: Option<Instant>,
}

struct Wait {
    on: WaitFor,
    until: Instant,
    /// `until` on the clock, for the row.
    until_clock: DateTime<Local>,
    /// The user asked to stop and start it: the stop that is still owed is the
    /// first half of it, and does not cancel the second.
    restart: bool,
}

impl Wait {
    fn view<S>(&self) -> View<S> {
        View::Waiting {
            on: self.on.clone(),
            until: self.until_clock,
        }
    }
}

struct Starting {
    seq: u64,
    stop: bool,
}

/// A service stored to run on an agent that has not been asked since the app
/// started (#6051).
struct Expected {
    agent_id: String,
    seq: u64,
    /// The user stopped, moved or deleted it before the answer: what runs is
    /// stopped there, not taken over.
    orphan: bool,
}

struct Inner<S> {
    /// Tells a record from a later one of the same service.
    seq: u64,
    live: HashMap<String, Live<S>>,
    /// Stops an agent has not confirmed, by (agent, service): a service that
    /// was moved meanwhile has its own record on its new agent.
    owed: HashMap<(String, String), Owed>,
    waits: HashMap<String, Wait>,
    starting: HashMap<String, Starting>,
    expected: HashMap<String, Expected>,
}

impl<S> Inner<S> {
    fn next_seq(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    fn begin(&mut self, id: &str) -> Result<Ticket, Busy> {
        if self.live.contains_key(id) {
            return Err(Busy::Running);
        }
        if self.starting.contains_key(id) {
            return Err(Busy::Starting);
        }
        self.waits.remove(id);
        // A start answers the question of what runs there.
        self.expected.remove(id);
        let seq = self.next_seq();
        self.starting
            .insert(id.to_string(), Starting { seq, stop: false });
        Ok(Ticket {
            id: id.to_string(),
            seq,
        })
    }

    fn owe(&mut self, agent_id: &str, id: &str, settle_at: Option<Instant>) {
        let seq = self.next_seq();
        self.owed.insert(
            (agent_id.to_string(), id.to_string()),
            Owed { seq, settle_at },
        );
    }
}

/// Where the stops an agent owes are kept between app runs (#6051).
struct OwedFile {
    path: PathBuf,
    /// One write at a time, each of the latest stops.
    write: Mutex<()>,
}

/// One owed stop on disk.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwedStop {
    agent_id: String,
    id: String,
}

/// The records of one manager's services. A clone shares them.
pub struct HostedServices<K: HostedKind> {
    inner: Arc<Mutex<Inner<K::State>>>,
    file: Option<Arc<OwedFile>>,
    /// Held while an owed stop is sent, so a Restart's send and the Stop's
    /// background send never overlap: the second finds it confirmed and sends
    /// nothing, so no late stop reaches the agent after the new start.
    sending_stop: Arc<Mutex<()>>,
}

impl<K: HostedKind> Clone for HostedServices<K> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
            file: self.file.clone(),
            sending_stop: Arc::clone(&self.sending_stop),
        }
    }
}

impl<K: HostedKind> Default for HostedServices<K> {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                seq: 0,
                live: HashMap::new(),
                owed: HashMap::new(),
                waits: HashMap::new(),
                starting: HashMap::new(),
                expected: HashMap::new(),
            })),
            file: None,
            sending_stop: Arc::new(Mutex::new(())),
        }
    }
}

impl<K: HostedKind> HostedServices<K> {
    /// Records whose owed stops are kept in `path`, with those of the last run
    /// (#6051). A file that cannot be read owes nothing.
    pub fn stored(path: PathBuf) -> Self {
        let services = Self {
            file: Some(Arc::new(OwedFile {
                path,
                write: Mutex::new(()),
            })),
            ..Self::default()
        };
        let owed: Vec<OwedStop> = services
            .file
            .as_ref()
            .and_then(|file| std::fs::read(&file.path).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        {
            let mut inner = services.lock();
            for stop in owed {
                inner.owe(&stop.agent_id, &stop.id, None);
            }
        }
        services
    }

    fn lock(&self) -> MutexGuard<'_, Inner<K::State>> {
        // The maps stay consistent when a holder panicked.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Keep the owed stops on disk, when they are kept. A failure is logged:
    /// the stops are still sent in this run.
    fn save_owed(&self) {
        let Some(file) = &self.file else {
            return;
        };
        let _one = file.write.lock().unwrap_or_else(|e| e.into_inner());
        let mut owed: Vec<OwedStop> = self
            .lock()
            .owed
            .keys()
            .map(|(agent_id, id)| OwedStop {
                agent_id: agent_id.clone(),
                id: id.clone(),
            })
            .collect();
        owed.sort_by(|a, b| (&a.agent_id, &a.id).cmp(&(&b.agent_id, &b.id)));
        let written = serde_json::to_vec(&owed)
            .map_err(std::io::Error::other)
            .and_then(|bytes| termihub_core::util::persist::write_atomic(&file.path, bytes));
        if let Err(error) = written {
            tracing::warn!(path = %file.path.display(), %error, "could not keep the owed stops");
        }
    }

    /// After an app start: ask agent `agent_id` whether `id`, stored to run
    /// there, still does, and take it over when it does (#6051). Nothing while
    /// a stop of it is owed there, or it runs or starts already.
    pub fn expect(&self, id: &str, agent_id: &str) {
        let mut inner = self.lock();
        let owed = inner
            .owed
            .contains_key(&(agent_id.to_string(), id.to_string()));
        if owed || inner.live.contains_key(id) || inner.starting.contains_key(id) {
            return;
        }
        let seq = inner.next_seq();
        inner.expected.insert(
            id.to_string(),
            Expected {
                agent_id: agent_id.to_string(),
                seq,
                orphan: false,
            },
        );
    }

    // ─── Reading ──────────────────────────────────────────────────────────

    /// What the row of `id` shows, or `None` when the manager decides.
    /// `host` is the agent it is stored to run on, when it is one.
    pub fn view(&self, id: &str, host: Option<&str>) -> Option<View<K::State>> {
        let inner = self.lock();
        if let Some(live) = inner.live.get(id) {
            let (agent_id, state) = (live.agent_id.clone(), live.state.clone());
            return Some(match live.presence {
                Presence::Here => View::Running { agent_id, state },
                Presence::Away(why) => View::NotReachable {
                    agent_id,
                    state,
                    why,
                },
            });
        }
        if let Some(starting) = inner.starting.get(id) {
            return Some(match host {
                Some(agent_id) if starting.stop => View::Stopping {
                    agent_id: agent_id.to_string(),
                },
                _ => View::Starting,
            });
        }
        let wait = inner.waits.get(id);
        if let Some(wait) = wait.filter(|wait| wait.restart) {
            return Some(wait.view());
        }
        if let Some(agent_id) = host {
            if inner
                .owed
                .contains_key(&(agent_id.to_string(), id.to_string()))
            {
                return Some(View::Stopping {
                    agent_id: agent_id.to_string(),
                });
            }
        }
        wait.map(Wait::view)
    }

    /// Whether the agent of `id` says that it runs.
    pub fn is_running(&self, id: &str) -> bool {
        self.lock()
            .live
            .get(id)
            .is_some_and(|live| live.presence == Presence::Here)
    }

    /// Whether `id` runs on an agent, starts or waits for it.
    pub fn is_engaged(&self, id: &str) -> bool {
        let inner = self.lock();
        inner.live.contains_key(id)
            || inner.starting.contains_key(id)
            || inner.waits.contains_key(id)
    }

    /// The agent `id` runs on.
    pub fn agent_id_of(&self, id: &str) -> Option<String> {
        self.lock().live.get(id).map(|live| live.agent_id.clone())
    }

    /// The services an agent says it runs, with what it last reported.
    pub fn running(&self) -> Vec<(String, K::State)> {
        self.lock()
            .live
            .iter()
            .filter(|(_, live)| live.presence == Presence::Here)
            .map(|(id, live)| (id.clone(), live.state.clone()))
            .collect()
    }

    /// Whether a tick has more to do than to ask the agents.
    pub fn needs_tick(&self) -> bool {
        let inner = self.lock();
        !inner.waits.is_empty() || !inner.owed.is_empty()
    }

    /// Whether there is anything to poll or wait for, now or after a start.
    pub fn any(&self) -> bool {
        let inner = self.lock();
        !(inner.live.is_empty()
            && inner.owed.is_empty()
            && inner.waits.is_empty()
            && inner.starting.is_empty()
            && inner.expected.is_empty())
    }

    // ─── Waiting ──────────────────────────────────────────────────────────

    /// Let the automatic start of `id` wait for `on`. A wait that is there
    /// keeps its deadline. Returns whether the row changed; `false` as well
    /// when it already runs or starts.
    pub fn wait(&self, id: &str, on: WaitFor, now: Instant) -> bool {
        self.lock_and_wait(id, on, now, false)
    }

    /// [`wait`](Self::wait) as the second half of a restart the user asked for:
    /// a stop that is still owed does not cancel it.
    pub fn wait_to_restart(&self, id: &str, on: WaitFor, now: Instant) -> bool {
        self.lock_and_wait(id, on, now, true)
    }

    fn lock_and_wait(&self, id: &str, on: WaitFor, now: Instant, restart: bool) -> bool {
        let mut inner = self.lock();
        if inner.live.contains_key(id) || inner.starting.contains_key(id) {
            return false;
        }
        if let Some(wait) = inner.waits.get_mut(id) {
            let changed = wait.on != on;
            wait.on = on;
            wait.restart |= restart;
            return changed;
        }
        let wait = Wait {
            on,
            until: now + WAIT_LIMIT,
            until_clock: Local::now() + WAIT_LIMIT,
            restart,
        };
        inner.waits.insert(id.to_string(), wait);
        true
    }

    /// Whether a start `by` must not run, because the user stopped `id` and
    /// agent `agent_id` has not confirmed that yet.
    pub fn stop_wins(&self, agent_id: &str, id: &str, by: StartedBy) -> bool {
        let inner = self.lock();
        by != StartedBy::User
            && inner
                .owed
                .contains_key(&(agent_id.to_string(), id.to_string()))
            && !inner.waits.get(id).is_some_and(|wait| wait.restart)
    }

    /// Until when the automatic start of `id` waits, if it waits.
    pub fn waits_until(&self, id: &str) -> Option<DateTime<Local>> {
        self.lock().waits.get(id).map(|wait| wait.until_clock)
    }

    /// The services that wait.
    pub fn waiting(&self) -> Vec<(String, WaitFor)> {
        self.lock()
            .waits
            .iter()
            .map(|(id, wait)| (id.clone(), wait.on.clone()))
            .collect()
    }

    /// End the waits whose time is up at `now`, and say what each waited for.
    pub fn take_expired(&self, now: Instant) -> Vec<(String, WaitFor)> {
        let mut inner = self.lock();
        let over: Vec<String> = inner
            .waits
            .iter()
            .filter(|(_, wait)| wait.until <= now)
            .map(|(id, _)| id.clone())
            .collect();
        over.into_iter()
            .filter_map(|id| inner.waits.remove(&id).map(|wait| (id, wait.on)))
            .collect()
    }

    // ─── Starting ─────────────────────────────────────────────────────────

    /// Begin a start of `id`, ending its wait.
    pub fn begin(&self, id: &str) -> Result<Ticket, Busy> {
        self.lock().begin(id)
    }

    /// [`begin`](Self::begin) the start `id` waits for; `None` when it does not
    /// wait (any more), so a stop during the wait is never lost.
    pub fn begin_waiting(&self, id: &str) -> Option<Ticket> {
        let mut inner = self.lock();
        if !inner.waits.contains_key(id) {
            return None;
        }
        inner.begin(id).ok()
    }

    /// End the start `ticket`.
    pub fn finish(&self, ticket: Ticket, outcome: Outcome<K::State>, now: Instant) -> Finished {
        let mut inner = self.lock();
        let stop = match inner.starting.get(&ticket.id) {
            Some(s) if s.seq == ticket.seq => {
                let stop = s.stop;
                inner.starting.remove(&ticket.id);
                stop
            }
            _ => true,
        };
        let (agent_id, state, unanswered) = match outcome {
            Outcome::Failed if stop => return Finished::Stopped,
            Outcome::Failed => return Finished::Done,
            Outcome::Started { agent_id, state } => (agent_id, state, false),
            Outcome::Unanswered { agent_id, state } => (agent_id, state, true),
        };
        let settle_at = unanswered.then(|| now + UNKNOWN_SETTLE);
        if stop {
            inner.owe(&agent_id, &ticket.id, settle_at);
            drop(inner);
            self.save_owed();
            return Finished::StopThere(agent_id);
        }
        // It runs there now, so an older stop of it is settled.
        let settled = inner
            .owed
            .remove(&(agent_id.clone(), ticket.id.clone()))
            .is_some();
        let seq = inner.next_seq();
        inner.live.insert(
            ticket.id,
            Live {
                agent_id,
                state,
                presence: if unanswered {
                    Presence::Away(Away::StartUnanswered)
                } else {
                    Presence::Here
                },
                settle_at,
                misses: 0,
                seq,
            },
        );
        drop(inner);
        if settled {
            self.save_owed();
        }
        Finished::Done
    }

    // ─── Stopping ─────────────────────────────────────────────────────────

    /// Stop `id`, whatever it is doing. From here on it never starts by itself.
    pub fn stop(&self, id: &str) -> StopPlan {
        let mut inner = self.lock();
        let waited = inner.waits.remove(id).is_some();
        // Not asked yet after a restart: what runs there is stopped, not taken over.
        if let Some(expected) = inner.expected.get_mut(id) {
            expected.orphan = true;
        }
        if let Some(live) = inner.live.remove(id) {
            inner.owe(&live.agent_id, id, live.settle_at);
            drop(inner);
            self.save_owed();
            return StopPlan::StopThere(live.agent_id);
        }
        if let Some(starting) = inner.starting.get_mut(id) {
            starting.stop = true;
            return StopPlan::StartWillStop;
        }
        if waited {
            StopPlan::StoppedWaiting
        } else {
            StopPlan::Nothing
        }
    }

    /// Take back the stop that agent `agent_id` has not got for `id` ("Keep
    /// running", #6076): what may run there is followed again. Returns whether
    /// there was one.
    pub fn keep(&self, agent_id: &str, id: &str) -> bool {
        let mut inner = self.lock();
        // A restart is that stop and a start: there is nothing to keep.
        if inner.waits.contains_key(id) || inner.live.contains_key(id) {
            return false;
        }
        let key = (agent_id.to_string(), id.to_string());
        let Some(owed) = inner.owed.remove(&key) else {
            return false;
        };
        let seq = inner.next_seq();
        let live = Live {
            agent_id: agent_id.to_string(),
            state: K::unknown_state(id),
            presence: Presence::Away(Away::Offline),
            settle_at: owed.settle_at,
            misses: 0,
            seq,
        };
        inner.live.insert(id.to_string(), live);
        drop(inner);
        self.save_owed();
        true
    }

    /// Send the stop that agent `agent_id` owes for `id`. Returns whether the
    /// agent confirmed it; else it stays owed and is sent again.
    pub fn send_owed_stop(
        &self,
        client: &dyn AgentRpcClient,
        agent_id: &str,
        id: &str,
        now: Instant,
    ) -> bool {
        let key = (agent_id.to_string(), id.to_string());
        // One send at a time (a Restart sends while the Stop's background send
        // may still be out). A poisoned lock still serializes.
        let _sending = self
            .sending_stop
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(seq) = self.lock().owed.get(&key).map(|owed| owed.seq) else {
            return true;
        };
        let probe = ask::<K>(client, agent_id, id, &Ask::Stop).0;
        // Settled meanwhile by the poller's stop: that confirmed it too.
        self.settle(&key, seq, &probe, now) || !self.lock().owed.contains_key(&key)
    }

    fn settle(
        &self,
        key: &(String, String),
        seq: u64,
        probe: &Probe<K::State>,
        now: Instant,
    ) -> bool {
        let mut inner = self.lock();
        let done = matches!(probe, Probe::NotRunning)
            && inner
                .owed
                .get(key)
                .is_some_and(|o| o.seq == seq && o.settle_at.is_none_or(|at| at <= now));
        if done {
            inner.owed.remove(key);
            drop(inner);
            self.save_owed();
        }
        done
    }

    /// Forget the stops the agents that `is_removed` names owe: nothing can
    /// ever confirm them. Returns the services whose row may change.
    pub fn forget_removed_agents(&self, is_removed: impl Fn(&str) -> bool) -> Vec<String> {
        let agents: HashSet<String> = {
            let inner = self.lock();
            inner.owed.keys().map(|(agent, _)| agent.clone()).collect()
        };
        let removed: HashSet<String> = agents.into_iter().filter(|a| is_removed(a)).collect();
        if removed.is_empty() {
            return Vec::new();
        }
        let mut ids = Vec::new();
        self.lock().owed.retain(|(agent, id), _| {
            let keep = !removed.contains(agent);
            if !keep {
                ids.push(id.clone());
            }
            keep
        });
        self.save_owed();
        ids
    }

    /// The services to stop when the app quits: those that run on an agent.
    pub fn live_ids(&self) -> Vec<String> {
        self.lock().live.keys().cloned().collect()
    }

    // ─── Asking the agents ────────────────────────────────────────────────

    /// What to ask the agents on this tick.
    pub fn targets(&self) -> Vec<Target<K::State>> {
        let inner = self.lock();
        let status = inner.live.iter().map(|(id, live)| Target {
            id: id.clone(),
            agent_id: live.agent_id.clone(),
            seq: live.seq,
            ask: Ask::Status(live.state.clone()),
        });
        let stops = inner.owed.iter().map(|((agent_id, id), owed)| Target {
            id: id.clone(),
            agent_id: agent_id.clone(),
            seq: owed.seq,
            ask: Ask::Stop,
        });
        let finds = inner.expected.iter().map(|(id, expected)| Target {
            id: id.clone(),
            agent_id: expected.agent_id.clone(),
            seq: expected.seq,
            ask: Ask::Find(K::unknown_state(id)),
        });
        status.chain(stops).chain(finds).collect()
    }

    /// Ask the agents. Blocking; an agent that leaves one request unanswered is
    /// not asked again in this batch.
    pub fn poll(
        client: &dyn AgentRpcClient,
        targets: &[Target<K::State>],
    ) -> Vec<Sample<K::State>> {
        let mut silent: HashSet<&str> = HashSet::new();
        targets
            .iter()
            .map(|target| {
                let probe = if silent.contains(target.agent_id.as_str()) {
                    Probe::NoAnswer
                } else {
                    let (probe, timed_out) =
                        ask::<K>(client, &target.agent_id, &target.id, &target.ask);
                    if timed_out {
                        silent.insert(&target.agent_id);
                    }
                    probe
                };
                Sample {
                    id: target.id.clone(),
                    agent_id: target.agent_id.clone(),
                    seq: target.seq,
                    stop: matches!(target.ask, Ask::Stop),
                    find: matches!(target.ask, Ask::Find(_)),
                    probe,
                }
            })
            .collect()
    }

    /// Write the answers back. An answer about a record that changed since it
    /// was asked is dropped.
    pub fn apply(&self, samples: Vec<Sample<K::State>>, now: Instant) -> Vec<Change> {
        let mut changes = Vec::new();
        for sample in samples {
            if sample.stop {
                let key = (sample.agent_id, sample.id);
                if self.settle(&key, sample.seq, &sample.probe, now) {
                    changes.push(Change::Stopped(key.1));
                }
                continue;
            }
            if sample.find {
                changes.extend(self.apply_find(sample));
                continue;
            }
            changes.extend(self.apply_status(sample, now));
        }
        changes
    }

    /// What the agent said about a service it may still run after a restart.
    fn apply_find(&self, sample: Sample<K::State>) -> Option<Change> {
        let mut inner = self.lock();
        let expected = inner.expected.get(&sample.id)?;
        if expected.seq != sample.seq {
            return None;
        }
        let orphan = expected.orphan;
        let state = match sample.probe {
            // Asked again on a later tick.
            Probe::Offline | Probe::NoAnswer => return None,
            Probe::NotRunning => {
                inner.expected.remove(&sample.id);
                return None;
            }
            Probe::Running(state) => state,
        };
        inner.expected.remove(&sample.id);
        if orphan {
            inner.owe(&sample.agent_id, &sample.id, None);
            drop(inner);
            self.save_owed();
            return None;
        }
        let seq = inner.next_seq();
        inner.live.insert(
            sample.id.clone(),
            Live {
                agent_id: sample.agent_id,
                state,
                presence: Presence::Here,
                settle_at: None,
                misses: 0,
                seq,
            },
        );
        Some(Change::Presence(sample.id))
    }

    fn apply_status(&self, sample: Sample<K::State>, now: Instant) -> Option<Change> {
        let mut inner = self.lock();
        let live = inner.live.get_mut(&sample.id)?;
        if live.seq != sample.seq {
            return None;
        }
        let before = live.presence;
        match sample.probe {
            Probe::Running(state) => {
                let news = K::is_news(&live.state, &state);
                live.state = state;
                live.presence = Presence::Here;
                live.settle_at = None;
                live.misses = 0;
                if before == Presence::Here {
                    return Some(Change::Sampled {
                        id: sample.id,
                        news,
                    });
                }
            }
            Probe::NotRunning => {
                live.misses = 0;
                let unanswered = live.settle_at.is_some();
                if live.settle_at.is_some_and(|at| now < at) {
                    return None;
                }
                inner.live.remove(&sample.id);
                return Some(Change::Gone {
                    id: sample.id,
                    agent_id: sample.agent_id,
                    unanswered,
                });
            }
            Probe::Offline => live.go_away(Away::Offline),
            Probe::NoAnswer => {
                live.misses = live.misses.saturating_add(1);
                if live.misses >= MISSES {
                    live.go_away(Away::Silent);
                }
            }
        }
        (live.presence != before).then_some(Change::Presence(sample.id))
    }
}

impl<S> Live<S> {
    /// It is not reachable. An unanswered start stays one: it is the better
    /// reason until the agent answers.
    fn go_away(&mut self, why: Away) {
        if self.presence != Presence::Away(Away::StartUnanswered) {
            self.presence = Presence::Away(why);
        }
    }
}

/// Send one request, and say whether it timed out.
fn ask<K: HostedKind>(
    client: &dyn AgentRpcClient,
    agent_id: &str,
    id: &str,
    what: &Ask<K::State>,
) -> (Probe<K::State>, bool) {
    if !client.is_reachable(agent_id) {
        return (Probe::Offline, false);
    }
    let ((method, params), timeout) = match what {
        Ask::Status(_) | Ask::Find(_) => (K::status_request(id), STATUS_TIMEOUT),
        Ask::Stop => (K::stop_request(id), STOP_TIMEOUT),
    };
    match client.send_request_bounded(agent_id, method, params, timeout) {
        Ok(reply) => {
            let probe = match what {
                Ask::Stop => Probe::NotRunning,
                Ask::Status(last) | Ask::Find(last) => match K::read_status(id, &reply, last) {
                    Reading::Running(state) => Probe::Running(state),
                    Reading::NotRunning => Probe::NotRunning,
                    Reading::Unreadable => Probe::NoAnswer,
                },
            };
            (probe, false)
        }
        Err(TerminalError::AgentTransportClosed(_)) => (Probe::Offline, false),
        Err(error) => {
            tracing::debug!(agent_id, id, method, %error, "agent did not answer");
            (
                Probe::NoAnswer,
                matches!(error, TerminalError::AgentTimeout(_)),
            )
        }
    }
}

/// Whether `error` leaves open if the agent did what it was asked: the request
/// may have reached it, but no answer came back.
pub fn is_unanswered(error: &TerminalError) -> bool {
    matches!(
        error,
        TerminalError::AgentTimeout(_) | TerminalError::AgentTransportClosed(_)
    )
}

#[cfg(test)]
#[path = "hosted_tests.rs"]
mod tests;

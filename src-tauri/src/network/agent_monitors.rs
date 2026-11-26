//! HTTP monitors on agents (#2592), with the states of services (#6052): a
//! monitor whose agent is gone is not reachable, a start the agent did not
//! answer may still check there, and a stop the agent did not get is owed until
//! it does, also across an app restart. The records are the shared
//! [`HostedServices`]; pause and resume are the monitor's own.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;

use serde_json::Value;
use tauri::{AppHandle, Runtime};
use termihub_core::protocol::methods::{
    ServiceStatusParams, ServiceStatusResult, ServiceStopParams, SERVICE_STATUS, SERVICE_STOP,
};
use termihub_core::util::entry_extra::without_extra;
use termihub_core::util::service_host::ServiceHost;

use crate::agent_service::hosted::{
    Change, Finished, HostedKind, HostedServices, Reading, Sample, Target, View,
};
use crate::agent_service::{not_reachable_reason, stopping_reason, unanswered_start_failed};

use super::http_monitor::{
    HttpCheckResult, HttpMonitorConfig, HttpMonitorState, HttpMonitorStatus,
};

/// What is known of a monitor on an agent: its latest check.
pub(super) type Seen = Option<HttpCheckResult>;

/// The monitor side of [`HostedServices`].
pub(super) struct HostedMonitors;

impl HostedKind for HostedMonitors {
    type State = Seen;

    fn unknown_state(_id: &str) -> Seen {
        None
    }

    fn stop_request(id: &str) -> (&'static str, Value) {
        let params = ServiceStopParams {
            instance_id: id.to_string(),
        };
        (
            SERVICE_STOP,
            serde_json::to_value(params).unwrap_or(Value::Null),
        )
    }

    fn status_request(id: &str) -> (&'static str, Value) {
        let params = ServiceStatusParams {
            instance_id: id.to_string(),
        };
        (
            SERVICE_STATUS,
            serde_json::to_value(params).unwrap_or(Value::Null),
        )
    }

    fn read_status(id: &str, reply: &Value, last: &Seen) -> Reading<Seen> {
        let Ok(status) = serde_json::from_value::<ServiceStatusResult>(reply.clone()) else {
            return Reading::Unreadable;
        };
        if !status.running {
            return Reading::NotRunning;
        }
        Reading::Running(super::parse_agent_check(id, reply).or_else(|| last.clone()))
    }

    fn is_news(before: &Seen, after: &Seen) -> bool {
        let at = |seen: &Seen| seen.as_ref().map(|check| check.timestamp_ms);
        at(before) != at(after)
    }
}

/// The monitors set to run on agents, and what is known of them.
pub(super) struct AgentMonitors {
    pub(super) hosted: HostedServices<HostedMonitors>,
    /// By monitor id: the config, which names the agent in its `host`.
    configs: Mutex<HashMap<String, HttpMonitorConfig>>,
    paused: Mutex<HashSet<String>>,
    /// Why a monitor did not start there, until the next start or a stop.
    refusals: Mutex<HashMap<String, String>>,
}

/// What a check that arrived from an agent means for the row.
pub(super) struct Applied {
    /// New checks, to record and to send on.
    pub(super) checks: Vec<HttpCheckResult>,
    /// Whether a row changed more than its numbers.
    pub(super) changed: bool,
}

impl AgentMonitors {
    /// Monitors whose owed stops are kept beside the other files in `dir`.
    pub(super) fn stored(dir: &Path) -> Self {
        Self::with(HostedServices::stored(
            dir.join("http_monitors_owed_stops.json"),
        ))
    }

    pub(super) fn with(hosted: HostedServices<HostedMonitors>) -> Self {
        Self {
            hosted,
            configs: Mutex::new(HashMap::new()),
            paused: Mutex::new(HashSet::new()),
            refusals: Mutex::new(HashMap::new()),
        }
    }

    fn configs(&self) -> MutexGuard<'_, HashMap<String, HttpMonitorConfig>> {
        self.configs.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn paused(&self) -> MutexGuard<'_, HashSet<String>> {
        self.paused.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn refusals(&self) -> MutexGuard<'_, HashMap<String, String>> {
        self.refusals.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Keep `config` listed as a monitor on its agent.
    pub(super) fn list(&self, config: HttpMonitorConfig) {
        self.configs().insert(config.id.clone(), config);
    }

    /// Whether `id` is a monitor on an agent.
    pub(super) fn has(&self, id: &str) -> bool {
        self.configs().contains_key(id)
    }

    pub(super) fn config(&self, id: &str) -> Option<HttpMonitorConfig> {
        self.configs().get(id).cloned()
    }

    pub(super) fn ids(&self) -> Vec<String> {
        self.configs().keys().cloned().collect()
    }

    /// Drop `id` from the list; a stop it owes stays owed.
    pub(super) fn forget(&self, id: &str) {
        self.configs().remove(id);
        self.paused().remove(id);
        self.refusals().remove(id);
    }

    pub(super) fn refuse(&self, id: &str, reason: String) {
        self.refusals().insert(id.to_string(), reason);
    }

    pub(super) fn clear_refusal(&self, id: &str) {
        self.refusals().remove(id);
    }

    pub(super) fn set_paused(&self, id: &str, paused: bool) {
        if paused {
            self.paused().insert(id.to_string());
        } else {
            self.paused().remove(id);
        }
    }

    pub(super) fn is_paused(&self, id: &str) -> bool {
        self.paused().contains(id)
    }

    /// The running monitor on an agent whose URL is `url`.
    pub(super) fn running_with_url(&self, url: &str) -> Option<String> {
        let configs = self.configs();
        configs
            .values()
            .find(|c| c.url == url && self.hosted.is_running(&c.id))
            .map(|c| c.id.clone())
    }

    /// What the row of each listed monitor shows. `app` words the reasons.
    pub(super) fn states<R: Runtime>(&self, app: Option<&AppHandle<R>>) -> Vec<HttpMonitorState> {
        let configs: Vec<HttpMonitorConfig> = self.configs().values().cloned().collect();
        configs
            .into_iter()
            .map(|config| self.state_of(config, app))
            .collect()
    }

    fn state_of<R: Runtime>(
        &self,
        config: HttpMonitorConfig,
        app: Option<&AppHandle<R>>,
    ) -> HttpMonitorState {
        let agent = agent_of(&config).map(str::to_string);
        let view = self.hosted.view(&config.id, agent.as_deref());
        let paused = self.is_paused(&config.id);
        let refusal = self.refusals().get(&config.id).cloned();
        let (status, last_result, reason) = match view {
            Some(View::Running { state, .. }) => (HttpMonitorStatus::Running, state, None),
            Some(View::NotReachable {
                agent_id,
                state,
                why,
            }) => {
                let reason = app.map(|app| not_reachable_reason(app, &agent_id, why).text);
                (HttpMonitorStatus::NotReachable, state, reason)
            }
            Some(View::Stopping { agent_id }) => {
                let reason = app.map(|app| stopping_reason(app, &agent_id).text);
                (HttpMonitorStatus::Stopping, None, reason)
            }
            Some(View::Starting) | Some(View::Waiting { .. }) => {
                (HttpMonitorStatus::Starting, None, None)
            }
            None if refusal.is_some() => (HttpMonitorStatus::Error, None, refusal),
            None => (HttpMonitorStatus::Stopped, None, None),
        };
        let running = status == HttpMonitorStatus::Running;
        HttpMonitorState {
            config,
            running,
            paused: running && paused,
            last_result,
            status,
            reason,
        }
    }

    /// Write back what the agents said. A monitor that never started says so.
    pub(super) fn apply(&self, samples: Vec<Sample<Seen>>) -> Applied {
        let changes = self.hosted.apply(samples, Instant::now());
        let mut applied = Applied {
            checks: Vec::new(),
            changed: false,
        };
        for change in changes {
            match change {
                Change::Sampled { id, news: true } => {
                    let check = self
                        .hosted
                        .running()
                        .into_iter()
                        .find(|(seen, _)| *seen == id);
                    if let Some((_, Some(check))) = check {
                        applied.checks.push(check);
                    }
                }
                Change::Sampled { .. } => {}
                Change::Gone {
                    id,
                    unanswered: true,
                    ..
                } => {
                    self.refuse(&id, unanswered_start_failed().text);
                    applied.changed = true;
                }
                Change::Gone { id, .. } => {
                    self.set_paused(&id, false);
                    applied.changed = true;
                }
                Change::Presence(_) | Change::Stopped(_) => applied.changed = true,
            }
        }
        applied
    }

    /// What to ask the agents on this tick, and whether anything is left.
    pub(super) fn targets(&self) -> (Vec<Target<Seen>>, bool) {
        (self.hosted.targets(), self.hosted.any())
    }

    /// End a start; a stop pressed meanwhile is the caller's to send.
    pub(super) fn finished(finished: Finished) -> Option<String> {
        match finished {
            Finished::StopThere(agent_id) => Some(agent_id),
            Finished::Done | Finished::Stopped => None,
        }
    }
}

/// The agent `config` is stored to run on, when it is one.
pub(super) fn agent_of(config: &HttpMonitorConfig) -> Option<&str> {
    match config.host.choice() {
        termihub_core::util::service_host::HostChoice::Agent(agent_id) => Some(agent_id),
        _ => None,
    }
}

/// The config an agent is sent: without the desktop's own fields.
pub(super) fn for_agent(config: &HttpMonitorConfig) -> HttpMonitorConfig {
    let mut config = without_extra(config);
    config.host = ServiceHost::default();
    config
}

#[cfg(test)]
#[path = "agent_monitors_tests.rs"]
mod tests;

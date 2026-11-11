//! The one scriptable [`AgentRpcClient`] shared by the `src-tauri` unit tests
//! (#5369).
//!
//! [`FakeAgent`] grew out of the network-tool fake (#3353, #3731): it records
//! every request, answers `tool.start` / `tool.run`, and hands the test the
//! streaming run's notification route so the test can play the agent's
//! `tool.event` / `tool.done` stream.
//!
//! On top of that, every session-plumbing method is **scriptable** per method
//! through [`FakeAgent::on`] (a one-shot queue, consumed in order) and
//! [`FakeAgent::always`] (the answer once the queue is empty). A [`Step`] can
//! succeed, reply with a value, fail, be delayed, or hang until the test opens a
//! [`Gate`]. A method that is neither scripted nor has a built-in answer
//! **panics**, so a test that must never reach the agent still proves it.
//! Every call is recorded with its arguments ([`FakeAgent::calls_to`]).

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use termihub_core::monitoring::MonitoringSender;
use termihub_core::protocol::methods::{TOOL_RUN, TOOL_START};

use super::session_host::SessionHost;
use crate::connection::config::AgentSettings;
use crate::terminal::agent_manager::files_only::FilesOnlyRoutes;
use crate::terminal::agent_manager::{
    AgentCapabilities, AgentConnectResult, AgentConnectionsData, AgentDefinitionInfo,
    AgentFolderInfo, AgentRpcClient, AgentSessionInfo, ToolRunSender,
};
use crate::terminal::backend::{OutputSender, RemoteAgentConfig};
use crate::utils::errors::TerminalError;

/// Builds the error a failing [`Step`] answers with (`TerminalError` is not
/// `Clone`, so a step that may fire repeatedly keeps a factory).
type ErrorFactory = Arc<dyn Fn() -> TerminalError + Send + Sync>;

/// Answers the agent requests it handles (`Some`) before any `send_request`
/// script; `None` falls through (#5372).
pub(crate) type Responder =
    dyn Fn(&str, &Value) -> Option<Result<Value, TerminalError>> + Send + Sync;

/// A latch a [`Step::Hang`] blocks on until the test opens it.
#[derive(Clone, Default)]
pub(crate) struct Gate(Arc<(Mutex<bool>, Condvar)>);

impl Gate {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Release every call blocked on this gate, now and later.
    pub(crate) fn open(&self) {
        let (open, cvar) = &*self.0;
        *open.lock().unwrap() = true;
        cvar.notify_all();
    }

    /// A guard that opens the gate when dropped — also when the test panics,
    /// so a call still hanging on it cannot keep the runtime from shutting down.
    pub(crate) fn open_on_drop(&self) -> OpenOnDrop {
        OpenOnDrop(self.clone())
    }

    fn wait(&self) {
        let (open, cvar) = &*self.0;
        let mut guard = open.lock().unwrap();
        while !*guard {
            guard = cvar.wait(guard).unwrap();
        }
    }
}

/// Opens its [`Gate`] when dropped (see [`Gate::open_on_drop`]).
pub(crate) struct OpenOnDrop(Gate);

impl Drop for OpenOnDrop {
    fn drop(&mut self) {
        self.0.open();
    }
}

/// One scripted answer to a [`FakeAgent`] method call.
#[derive(Clone)]
pub(crate) enum Step {
    /// Succeed with the method's neutral value: `Ok(())`, `true`, `Value::Null`.
    Ok,
    /// Succeed with this value; a typed method deserializes it (e.g. an
    /// [`AgentSessionInfo`] in the agent's snake_case wire format).
    Reply(Value),
    /// `create_session`: succeed with a freshly minted running, attached
    /// session titled after the request (`"mock"` without a title).
    NewSession,
    /// Fail with the error the factory builds.
    Fail(ErrorFactory),
    /// Sleep for the duration, then answer with the inner step.
    Delay(Duration, Box<Step>),
    /// Block the calling thread until the gate opens, then answer with the
    /// inner step.
    Hang(Gate, Box<Step>),
    /// Block the calling thread on a oneshot that a separately spawned tokio
    /// task fills shortly after, then answer with the inner step. This is how
    /// the real agent I/O task delivers a response across tasks, so a caller
    /// that blocks a runtime worker instead of using `spawn_blocking` can
    /// deadlock on the wake-up. Needs a tokio runtime context.
    CrossTask(Box<Step>),
}

impl Step {
    /// Fail with [`TerminalError::RemoteError`] carrying `message`.
    pub(crate) fn fail(message: &str) -> Self {
        let message = message.to_string();
        Self::Fail(Arc::new(move || {
            TerminalError::RemoteError(message.clone())
        }))
    }

    /// Fail with the error `make` builds.
    pub(crate) fn error(make: impl Fn() -> TerminalError + Send + Sync + 'static) -> Self {
        Self::Fail(Arc::new(make))
    }
}

/// Who answered a [`FakeAgent::hosted`] call: its script, or the session host.
enum Routed<T> {
    Scripted(Result<Answer, TerminalError>),
    Hosted(Result<T, TerminalError>),
}

/// What a scripted step resolved to, before the method shapes it.
enum Answer {
    Value(Value),
    NewSession,
}

/// Per-method script: one-shot steps first, then the standing answer.
#[derive(Default)]
pub(crate) struct Script {
    queue: VecDeque<Step>,
    always: Option<Step>,
}

/// An agent that records requests and hands the test the run's notification
/// route, so the test plays the agent's `tool.event` / `tool.done` stream; and
/// whose session-plumbing methods are scripted per test (see the module docs).
#[derive(Default)]
pub(crate) struct FakeAgent {
    /// Advertise `toolStreaming` (an agent at the network-tool floor, 0.9.0+).
    pub(crate) streaming: bool,
    /// Advertise `outputFlow` (an agent that can pause a session's output,
    /// #4416).
    pub(crate) output_flow: bool,
    /// Report no capabilities at all, as for an agent that is not connected.
    pub(crate) disconnected: bool,
    /// Report the agent as not connected (`is_connected == false`) and with no
    /// capabilities; unscripted requests and monitoring routes then panic too,
    /// so a test whose agent must never be reached proves it.
    pub(crate) offline: bool,
    /// Refuse `tool.start` (e.g. the per-connection run limit).
    pub(crate) refuse_start: bool,
    /// Methods every request to which fails with a remote error, e.g.
    /// `service.start` refused by the agent (#5288).
    pub(crate) refuse: Vec<&'static str>,
    /// Methods whose first `n` requests fail with a remote error before they
    /// start succeeding, e.g. an unsubscribe that only lands on a retry (#5301).
    pub(crate) refuse_times: Mutex<Vec<(&'static str, usize)>>,
    /// The reply to a `tool.run` request; `None` answers `-32601`-style failure.
    pub(crate) tool_run_reply: Option<Value>,
    pub(crate) route: Mutex<Option<ToolRunSender>>,
    pub(crate) unregistered: Mutex<Vec<String>>,
    pub(crate) requests: Mutex<Vec<(String, Value)>>,
    /// Registered monitoring output routes by host, as the agent manager's
    /// I/O task holds them (#5301).
    pub(crate) monitoring_routes: Mutex<Vec<(String, MonitoringSender)>>,
    /// While set, a plain `attach_session` is refused as held by another
    /// desktop (SM-003, #3404) until a `reclaim_session` takes the session
    /// over.
    pub(crate) held_by_peer: AtomicBool,
    /// Output senders handed to `register_session_output`, held so the
    /// session's output channel stays open (dropping one EOFs the reader).
    pub(crate) session_outputs: Mutex<Vec<OutputSender>>,
    /// Every scriptable call, as `(method, arguments)` (read it through
    /// [`calls_to`](Self::calls_to); public only so tests can use `..default()`).
    pub(crate) calls: Mutex<Vec<(&'static str, Vec<String>)>>,
    /// Per-method scripts (set them through [`on`](Self::on) /
    /// [`always`](Self::always)).
    pub(crate) scripts: Mutex<HashMap<&'static str, Script>>,
    /// A stateful session host (#5372): when set, the transport calls and the
    /// unscripted `create_session` / `list_sessions` answer from it (see
    /// [`session_host`](Self::session_host)).
    pub(crate) host: Option<SessionHost>,
    /// The capabilities `get_capabilities` reports when set, over the built-in
    /// ones and over `disconnected` (set through
    /// [`capabilities_mut`](Self::capabilities_mut)).
    pub(crate) capabilities: Option<AgentCapabilities>,
    /// Answers `send_request` for the methods it handles, after a script for
    /// that RPC method and before a `"send_request"` script.
    pub(crate) responder: Option<Box<Responder>>,
    /// The agent manager's real files-only routing (#4081): `register_files_only`
    /// registers here and `unregister_session_output` removes the route, so a
    /// test can deliver `connection.filesOnly` notifications through it.
    pub(crate) files_only_routes: Mutex<FilesOnlyRoutes>,
}

impl FakeAgent {
    pub(crate) fn streaming() -> Arc<Self> {
        Arc::new(Self {
            streaming: true,
            ..Self::default()
        })
    }

    /// An agent that is not connected and must never be called: every
    /// scriptable method panics until a test scripts it.
    pub(crate) fn offline() -> Self {
        Self {
            offline: true,
            ..Self::default()
        }
    }

    /// An agent backed by a [`SessionHost`]: its transport goes down and comes
    /// back through the host's flags, `create_session` mints `remote-{n}`
    /// while it is up, and `list_sessions` reports the minted sessions while
    /// they are recoverable. It reports no capabilities, and the rest of the
    /// session plumbing succeeds (each call recorded), so a test scripts only
    /// what it wants to break.
    pub(crate) fn session_host() -> Self {
        let mut agent = Self {
            disconnected: true,
            host: Some(SessionHost::default()),
            ..Self::default()
        };
        for method in [
            "disconnect_agent",
            "retain_agent_config",
            "send_request",
            "attach_session",
            "close_session",
            "register_session_output",
            "unregister_session_output",
            "send_session_input",
            "resize_session",
            "shutdown_agent",
            "apply_agent_settings",
            "list_connections_and_folders",
            "delete_definition",
            "delete_folder",
        ] {
            agent = agent.always(method, Step::Ok);
        }
        agent
    }

    /// The capabilities to report, starting from a minimal set (no connection
    /// types, ten sessions, every flag off) on first use.
    pub(crate) fn capabilities_mut(&mut self) -> &mut AgentCapabilities {
        self.capabilities.get_or_insert_with(|| {
            serde_json::from_value(json!({ "connectionTypes": [], "maxSessions": 10 }))
                .expect("minimal capabilities parse")
        })
    }

    /// The [`SessionHost`] of a [`session_host`](Self::session_host) agent.
    pub(crate) fn host(&self) -> &SessionHost {
        self.host
            .as_ref()
            .expect("FakeAgent: not a session_host agent")
    }

    /// Queue a one-shot answer for `method`; queued answers are used in order
    /// before the [`always`](Self::always) answer.
    pub(crate) fn on(self, method: &'static str, step: Step) -> Self {
        self.push(method, step);
        self
    }

    /// Answer every call to `method` (once its queue is empty) with `step`.
    pub(crate) fn always(self, method: &'static str, step: Step) -> Self {
        self.scripts
            .lock()
            .unwrap()
            .entry(method)
            .or_default()
            .always = Some(step);
        self
    }

    /// [`on`](Self::on) for an agent already shared behind an `Arc`.
    pub(crate) fn push(&self, method: &'static str, step: Step) {
        self.scripts
            .lock()
            .unwrap()
            .entry(method)
            .or_default()
            .queue
            .push_back(step);
    }

    /// The arguments of every call to `method`, in call order.
    pub(crate) fn calls_to(&self, method: &str) -> Vec<Vec<String>> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _)| *m == method)
            .map(|(_, args)| args.clone())
            .collect()
    }

    /// Every recorded call as `"method:arg1:arg2…"`, in call order.
    pub(crate) fn call_log(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|(m, args)| {
                std::iter::once(*m)
                    .chain(args.iter().map(String::as_str))
                    .collect::<Vec<_>>()
                    .join(":")
            })
            .collect()
    }

    pub(crate) fn requests(&self) -> Vec<(String, Value)> {
        self.requests.lock().unwrap().clone()
    }

    pub(crate) fn take_route(&self) -> Option<ToolRunSender> {
        self.route.lock().unwrap().take()
    }

    /// Wait (virtual time) until `tool.start` was sent; return the route.
    pub(crate) async fn started(&self) -> (ToolRunSender, String) {
        for _ in 0..1000 {
            let start = self
                .requests()
                .into_iter()
                .find(|(m, _)| m == TOOL_START)
                .map(|(_, p)| p);
            if let Some(p) = start {
                let route = self
                    .route
                    .lock()
                    .unwrap()
                    .clone()
                    .expect("route registered");
                return (route, p["runId"].as_str().unwrap().to_string());
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("tool.start never sent");
    }

    pub(crate) async fn wait_for_request(&self, method: &str) -> Value {
        for _ in 0..1000 {
            if let Some((_, p)) = self.requests().into_iter().find(|(m, _)| m == method) {
                return p;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("{method} never sent");
    }

    fn record(&self, method: &'static str, args: &[&str]) {
        self.calls
            .lock()
            .unwrap()
            .push((method, args.iter().map(|a| a.to_string()).collect()));
    }

    /// The scripted step for `method`, if any (the lock is released before the
    /// step runs, so a hanging step never blocks other calls).
    fn next_step(&self, method: &str) -> Option<Step> {
        let mut scripts = self.scripts.lock().unwrap();
        let script = scripts.get_mut(method)?;
        script.queue.pop_front().or_else(|| script.always.clone())
    }

    /// Record the call, then run its scripted step; `None` when unscripted.
    fn scripted(
        &self,
        method: &'static str,
        args: &[&str],
    ) -> Option<Result<Answer, TerminalError>> {
        self.record(method, args);
        self.next_step(method).map(run_step)
    }

    /// Like [`scripted`](Self::scripted), panicking when `method` is unscripted.
    fn strict(&self, method: &'static str, args: &[&str]) -> Result<Answer, TerminalError> {
        self.scripted(method, args)
            .unwrap_or_else(|| panic!("FakeAgent: unscripted call to {method}"))
    }

    /// Like [`strict`](Self::strict), but an unscripted call to a
    /// [`session_host`](Self::session_host) agent answers from `host`.
    fn hosted<T>(
        &self,
        method: &'static str,
        args: &[&str],
        host: impl FnOnce(&SessionHost) -> Result<T, TerminalError>,
    ) -> Routed<T> {
        match (self.scripted(method, args), &self.host) {
            (Some(answer), _) => Routed::Scripted(answer),
            (None, Some(h)) => Routed::Hosted(host(h)),
            (None, None) => panic!("FakeAgent: unscripted call to {method}"),
        }
    }

    fn strict_unit(&self, method: &'static str, args: &[&str]) -> Result<(), TerminalError> {
        self.strict(method, args).map(|_| ())
    }
}

fn run_step(step: Step) -> Result<Answer, TerminalError> {
    match step {
        Step::Ok => Ok(Answer::Value(Value::Null)),
        Step::Reply(value) => Ok(Answer::Value(value)),
        Step::NewSession => Ok(Answer::NewSession),
        Step::Fail(make) => Err(make()),
        Step::Delay(delay, then) => {
            std::thread::sleep(delay);
            run_step(*then)
        }
        Step::Hang(gate, then) => {
            gate.wait();
            run_step(*then)
        }
        Step::CrossTask(then) => {
            let (tx, rx) = tokio::sync::oneshot::channel::<()>();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(10)).await;
                let _ = tx.send(());
            });
            rx.blocking_recv()
                .map_err(|_| TerminalError::RemoteError("oneshot dropped".to_string()))?;
            run_step(*then)
        }
    }
}

fn typed<T: serde::de::DeserializeOwned>(method: &str, answer: Answer) -> T {
    match answer {
        Answer::Value(value) => serde_json::from_value(value)
            .unwrap_or_else(|e| panic!("FakeAgent: bad scripted reply for {method}: {e}")),
        Answer::NewSession => panic!("FakeAgent: Step::NewSession only answers create_session"),
    }
}

fn opt(value: Option<&str>) -> &str {
    value.unwrap_or("-")
}

#[allow(unused_variables)]
impl AgentRpcClient for FakeAgent {
    fn connect_agent(
        &self,
        agent_id: &str,
        config: &RemoteAgentConfig,
        agent_settings: Option<&AgentSettings>,
    ) -> Result<AgentConnectResult, TerminalError> {
        self.record("connect_agent", &[agent_id]);
        let Some(host) = &self.host else {
            unimplemented!()
        };
        host.connect();
        Ok(AgentConnectResult {
            capabilities: serde_json::from_value(json!({
                "connection_types": [],
                "max_sessions": 10
            }))
            .expect("minimal capabilities parse"),
            agent_version: "test".into(),
            protocol_version: "1".into(),
        })
    }
    fn cancel_connect(&self, agent_id: &str) -> bool {
        false
    }
    fn disconnect_agent(&self, agent_id: &str) -> Result<(), TerminalError> {
        self.strict_unit("disconnect_agent", &[agent_id])
    }
    fn is_connected(&self, agent_id: &str) -> bool {
        match &self.host {
            Some(host) => host.is_connected(),
            None => !self.offline,
        }
    }
    fn get_capabilities(&self, agent_id: &str) -> Option<AgentCapabilities> {
        if self.offline {
            return None;
        }
        if let Some(caps) = &self.capabilities {
            return Some(caps.clone());
        }
        if self.disconnected {
            return None;
        }
        Some(AgentCapabilities {
            connection_types: vec![],
            max_sessions: 1,
            available_shells: vec![],
            available_serial_ports: vec![],
            docker_available: false,
            available_docker_images: vec![],
            monitoring_supported: false,
            tool_streaming: self.streaming,
            embedded_server_activity: false,
            session_processes: false,
            session_monitoring: false,
            session_files: false,
            unattended_connect: false,
            file_ranges: false,
            output_flow: self.output_flow,
            host_file_attribute_ops: None,
            file_create_new: false,
            definition_icon_style: false,
            serial_port_rescan: false,
            agent_version: "0.8.1".to_string(),
        })
    }
    fn retain_agent_config(&self, agent_id: &str) -> bool {
        match self.scripted("retain_agent_config", &[agent_id]) {
            Some(Ok(Answer::Value(Value::Bool(retained)))) => retained,
            Some(answer) => answer.is_ok(),
            None => false,
        }
    }
    fn clear_retained_agent_config(&self, agent_id: &str) {
        self.record("clear_retained_agent_config", &[agent_id]);
    }
    fn reconnect_retained_agent(&self, agent_id: &str) -> Result<(), TerminalError> {
        // Unscripted and without a host: the trait default (no reattach).
        match (
            self.scripted("reconnect_retained_agent", &[agent_id]),
            &self.host,
        ) {
            (Some(answer), _) => answer.map(|_| ()),
            (None, Some(host)) => host.reconnect(),
            (None, None) => Err(TerminalError::RemoteError(format!(
                "Agent {agent_id} reattach not supported"
            ))),
        }
    }
    fn shutdown_agent(&self, agent_id: &str, reason: Option<&str>) -> Result<u32, TerminalError> {
        match self.strict("shutdown_agent", &[agent_id, opt(reason)])? {
            Answer::Value(Value::Null) => Ok(0),
            answer => Ok(typed("shutdown_agent", answer)),
        }
    }
    fn send_request(
        &self,
        agent_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, TerminalError> {
        self.requests
            .lock()
            .unwrap()
            .push((method.to_string(), params.clone()));
        // A script for this RPC method wins, then the responder, then a script
        // for every request.
        let mut scripted = self.next_step(method);
        if scripted.is_none() {
            if let Some(reply) = self.responder.as_ref().and_then(|r| r(method, &params)) {
                return reply;
            }
            scripted = self.next_step("send_request");
        }
        if let Some(step) = scripted {
            return run_step(step).map(|answer| match answer {
                Answer::Value(value) => value,
                Answer::NewSession => panic!("FakeAgent: Step::NewSession answered {method}"),
            });
        }
        assert!(
            !self.offline,
            "FakeAgent: unscripted {method} to an offline agent"
        );
        if self.refuse.contains(&method) {
            return Err(TerminalError::RemoteError(format!("{method} refused")));
        }
        if let Some((_, left)) = self
            .refuse_times
            .lock()
            .unwrap()
            .iter_mut()
            .find(|(m, left)| *m == method && *left > 0)
        {
            *left -= 1;
            return Err(TerminalError::RemoteError(format!("{method} refused")));
        }
        if method == TOOL_START && self.refuse_start {
            return Err(TerminalError::RemoteError("too many runs".to_string()));
        }
        if method == TOOL_RUN {
            return self
                .tool_run_reply
                .clone()
                .ok_or_else(|| TerminalError::RemoteError("Method not found".to_string()));
        }
        Ok(json!({ "runId": params["runId"] }))
    }
    fn register_tool_run(
        &self,
        agent_id: &str,
        run_id: &str,
        tx: ToolRunSender,
    ) -> Result<(), TerminalError> {
        *self.route.lock().unwrap() = Some(tx);
        Ok(())
    }
    fn unregister_tool_run(&self, agent_id: &str, run_id: &str) {
        self.unregistered.lock().unwrap().push(run_id.to_string());
    }
    fn create_session(
        &self,
        agent_id: &str,
        session_type: &str,
        config: Value,
        title: Option<&str>,
        definition_id: Option<&str>,
    ) -> Result<AgentSessionInfo, TerminalError> {
        let args = [agent_id, session_type, opt(title), opt(definition_id)];
        let answer = match self.hosted("create_session", &args, |h| h.create(session_type)) {
            Routed::Scripted(answer) => answer?,
            Routed::Hosted(result) => return result,
        };
        match answer {
            Answer::NewSession => Ok(AgentSessionInfo {
                session_id: uuid::Uuid::new_v4().to_string(),
                title: title.unwrap_or("mock").to_string(),
                session_type: session_type.to_string(),
                status: "running".to_string(),
                attached: true,
                definition_id: definition_id.map(str::to_string),
            }),
            answer => Ok(typed("create_session", answer)),
        }
    }
    fn create_session_owned(
        &self,
        agent_id: &str,
        session_type: &str,
        config: Value,
        title: Option<&str>,
        definition_id: Option<&str>,
        owner: Option<&str>,
        correlation_id: Option<&str>,
        unattended: bool,
    ) -> Result<AgentSessionInfo, TerminalError> {
        let unattended_arg = unattended.to_string();
        let args = [
            agent_id,
            session_type,
            opt(owner),
            opt(correlation_id),
            unattended_arg.as_str(),
        ];
        // A scripted owned create answers itself (e.g. a refused create);
        // otherwise it behaves as the trait default and delegates.
        match self.scripted("create_session_owned", &args) {
            Some(Err(e)) => Err(e),
            // `NewSession` delegates to `create_session` even for an
            // unattended create, as a fake that ignores the flag would.
            Some(Ok(Answer::NewSession)) => {
                self.create_session(agent_id, session_type, config, title, definition_id)
            }
            Some(Ok(answer)) => Ok(typed("create_session_owned", answer)),
            None if unattended => Err(TerminalError::SpawnFailed(
                "unattended connect is not supported".to_string(),
            )),
            None => self.create_session(agent_id, session_type, config, title, definition_id),
        }
    }
    fn attach_session(&self, agent_id: &str, remote_session_id: &str) -> Result<(), TerminalError> {
        let args = [agent_id, remote_session_id];
        if self.held_by_peer.load(Ordering::SeqCst) {
            self.record("attach_session", &args);
            return Err(TerminalError::SessionHeldByPeer(
                "Session is held by another desktop".to_string(),
            ));
        }
        self.strict_unit("attach_session", &args)
    }
    fn reclaim_session(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        self.held_by_peer.store(false, Ordering::SeqCst);
        self.scripted("reclaim_session", &[agent_id, remote_session_id])
            .unwrap_or(Ok(Answer::Value(Value::Null)))
            .map(|_| ())
    }
    fn close_session(&self, agent_id: &str, remote_session_id: &str) -> Result<(), TerminalError> {
        self.strict_unit("close_session", &[agent_id, remote_session_id])
    }
    fn list_sessions(&self, agent_id: &str) -> Result<Vec<AgentSessionInfo>, TerminalError> {
        match self.hosted("list_sessions", &[agent_id], |h| Ok(h.list())) {
            Routed::Scripted(answer) => answer.map(|a| typed("list_sessions", a)),
            Routed::Hosted(result) => result,
        }
    }
    fn list_connections_and_folders(
        &self,
        agent_id: &str,
    ) -> Result<AgentConnectionsData, TerminalError> {
        // Scriptable as succeed / fail only: the data has no wire form here.
        self.strict("list_connections_and_folders", &[agent_id])?;
        Ok(AgentConnectionsData {
            connections: vec![],
            folders: vec![],
        })
    }
    fn save_definition(
        &self,
        agent_id: &str,
        definition: termihub_core::protocol::methods::ConnectionCreateParams,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        unimplemented!()
    }
    fn update_definition(
        &self,
        agent_id: &str,
        params: termihub_core::protocol::methods::ConnectionUpdateParams,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        unimplemented!()
    }
    fn delete_definition(&self, agent_id: &str, def_id: &str) -> Result<(), TerminalError> {
        self.strict_unit("delete_definition", &[agent_id, def_id])
    }
    fn create_folder(
        &self,
        agent_id: &str,
        name: &str,
        parent_id: Option<&str>,
    ) -> Result<AgentFolderInfo, TerminalError> {
        unimplemented!()
    }
    fn update_folder(
        &self,
        agent_id: &str,
        params: termihub_core::protocol::methods::FolderUpdateParams,
    ) -> Result<AgentFolderInfo, TerminalError> {
        unimplemented!()
    }
    fn delete_folder(&self, agent_id: &str, folder_id: &str) -> Result<(), TerminalError> {
        self.strict_unit("delete_folder", &[agent_id, folder_id])
    }
    fn register_session_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        output_tx: OutputSender,
    ) -> Result<(), TerminalError> {
        self.strict_unit("register_session_output", &[agent_id, remote_session_id])?;
        self.session_outputs.lock().unwrap().push(output_tx);
        Ok(())
    }
    fn unregister_session_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        self.strict_unit("unregister_session_output", &[agent_id, remote_session_id])?;
        self.files_only_routes
            .lock()
            .unwrap()
            .remove(remote_session_id);
        Ok(())
    }
    fn register_files_only(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        files_only_tx: tokio::sync::watch::Sender<bool>,
    ) -> Result<(), TerminalError> {
        self.files_only_routes
            .lock()
            .unwrap()
            .register(remote_session_id.to_string(), files_only_tx);
        Ok(())
    }
    fn register_monitoring_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        monitoring_tx: MonitoringSender,
    ) -> Result<(), TerminalError> {
        assert!(
            !self.offline,
            "FakeAgent: monitoring route on an offline agent"
        );
        self.record("register_monitoring_output", &[agent_id, remote_session_id]);
        let mut routes = self.monitoring_routes.lock().unwrap();
        routes.retain(|(host, _)| host != remote_session_id);
        routes.push((remote_session_id.to_string(), monitoring_tx));
        Ok(())
    }
    fn unregister_monitoring_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        assert!(
            !self.offline,
            "FakeAgent: monitoring route on an offline agent"
        );
        self.monitoring_routes
            .lock()
            .unwrap()
            .retain(|(host, _)| host != remote_session_id);
        Ok(())
    }
    fn set_session_output_paused(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        paused: bool,
    ) -> Result<(), TerminalError> {
        let paused = paused.to_string();
        self.scripted(
            "set_session_output_paused",
            &[agent_id, remote_session_id, &paused],
        )
        .unwrap_or(Ok(Answer::Value(Value::Null)))
        .map(|_| ())
    }
    fn send_session_input(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        data: &[u8],
    ) -> Result<(), TerminalError> {
        self.strict_unit("send_session_input", &[agent_id, remote_session_id])
    }
    fn resize_session(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), TerminalError> {
        let size = format!("{cols}x{rows}");
        self.strict_unit("resize_session", &[agent_id, remote_session_id, &size])
    }
    fn apply_agent_settings(
        &self,
        agent_id: &str,
        settings: &AgentSettings,
    ) -> Result<(), TerminalError> {
        self.strict_unit("apply_agent_settings", &[agent_id])
    }
}

#[path = "agent_rpc_tests.rs"]
mod tests;

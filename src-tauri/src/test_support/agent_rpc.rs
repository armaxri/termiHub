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

use crate::connection::config::AgentSettings;
use crate::terminal::agent_manager::{
    AgentCapabilities, AgentConnectResult, AgentConnectionsData, AgentDefinitionInfo,
    AgentFolderInfo, AgentRpcClient, AgentSessionInfo, ToolRunSender,
};
use crate::terminal::backend::{OutputSender, RemoteAgentConfig};
use crate::utils::errors::TerminalError;

/// Builds the error a failing [`Step`] answers with (`TerminalError` is not
/// `Clone`, so a step that may fire repeatedly keeps a factory).
type ErrorFactory = Arc<dyn Fn() -> TerminalError + Send + Sync>;

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

    fn wait(&self) {
        let (open, cvar) = &*self.0;
        let mut guard = open.lock().unwrap();
        while !*guard {
            guard = cvar.wait(guard).unwrap();
        }
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

    fn strict_unit(&self, method: &'static str, args: &[&str]) -> Result<(), TerminalError> {
        self.strict(method, args).map(|_| ())
    }

    fn strict_typed<T: serde::de::DeserializeOwned>(
        &self,
        method: &'static str,
        args: &[&str],
    ) -> Result<T, TerminalError> {
        self.strict(method, args).map(|a| typed(method, a))
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
        unimplemented!()
    }
    fn cancel_connect(&self, agent_id: &str) -> bool {
        false
    }
    fn disconnect_agent(&self, agent_id: &str) -> Result<(), TerminalError> {
        self.strict_unit("disconnect_agent", &[agent_id])
    }
    fn is_connected(&self, agent_id: &str) -> bool {
        !self.offline
    }
    fn get_capabilities(&self, agent_id: &str) -> Option<AgentCapabilities> {
        if self.disconnected || self.offline {
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
    fn shutdown_agent(&self, agent_id: &str, reason: Option<&str>) -> Result<u32, TerminalError> {
        unimplemented!()
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
        // A script for this RPC method wins, then one for every request.
        let scripted = self
            .next_step(method)
            .or_else(|| self.next_step("send_request"));
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
        match self.strict("create_session", &args)? {
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
        self.strict_typed("list_sessions", &[agent_id])
    }
    fn list_connections_and_folders(
        &self,
        agent_id: &str,
    ) -> Result<AgentConnectionsData, TerminalError> {
        unimplemented!()
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
        unimplemented!()
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
        unimplemented!()
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
        self.strict_unit("unregister_session_output", &[agent_id, remote_session_id])
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
        unimplemented!()
    }
}

mod tests {
    use super::*;

    #[test]
    fn scripted_steps_answer_in_order_then_fall_back_to_always() {
        let agent = FakeAgent::offline()
            .on("close_session", Step::fail("first close fails"))
            .always("close_session", Step::Ok);
        assert!(agent.close_session("a", "r1").is_err());
        assert!(agent.close_session("a", "r2").is_ok());
        assert!(agent.close_session("a", "r3").is_ok());
        assert_eq!(
            agent.calls_to("close_session"),
            vec![
                vec!["a".to_string(), "r1".to_string()],
                vec!["a".to_string(), "r2".to_string()],
                vec!["a".to_string(), "r3".to_string()],
            ]
        );
    }

    #[test]
    #[should_panic(expected = "unscripted call to attach_session")]
    fn an_unscripted_method_panics() {
        let _ = FakeAgent::offline().attach_session("a", "r");
    }

    #[test]
    fn a_held_session_refuses_attach_until_reclaimed() {
        let agent = FakeAgent::default().always("attach_session", Step::Ok);
        agent.held_by_peer.store(true, Ordering::SeqCst);
        assert!(matches!(
            agent.attach_session("a", "r"),
            Err(TerminalError::SessionHeldByPeer(_))
        ));
        agent.reclaim_session("a", "r").unwrap();
        agent.attach_session("a", "r").unwrap();
        assert_eq!(agent.calls_to("attach_session").len(), 2);
        assert_eq!(agent.calls_to("reclaim_session").len(), 1);
    }

    #[test]
    fn a_hanging_step_blocks_until_its_gate_opens() {
        let gate = Gate::new();
        let agent = Arc::new(FakeAgent::default().on(
            "attach_session",
            Step::Hang(gate.clone(), Box::new(Step::Ok)),
        ));
        let worker = {
            let agent = agent.clone();
            std::thread::spawn(move || agent.attach_session("a", "r"))
        };
        std::thread::sleep(Duration::from_millis(20));
        assert!(!worker.is_finished(), "the attach must hang on the gate");
        gate.open();
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn a_delayed_step_answers_after_its_delay() {
        let agent = FakeAgent::default().on(
            "close_session",
            Step::Delay(Duration::from_millis(20), Box::new(Step::fail("late"))),
        );
        let started = std::time::Instant::now();
        assert!(agent.close_session("a", "r").is_err());
        assert!(started.elapsed() >= Duration::from_millis(20));
    }

    #[test]
    fn new_session_mints_a_running_attached_session() {
        let agent = FakeAgent::default().always("create_session", Step::NewSession);
        let a = agent
            .create_session("a", "local", json!({}), Some("T"), None)
            .unwrap();
        let b = agent
            .create_session("a", "local", json!({}), None, Some("def-1"))
            .unwrap();
        assert_ne!(a.session_id, b.session_id);
        assert_eq!(a.title, "T");
        assert_eq!(b.title, "mock");
        assert_eq!(b.definition_id.as_deref(), Some("def-1"));
        assert!(a.attached);
    }
}

//! A scripted [`AgentRpcClient`] shared by the network-tool unit tests.
//!
//! It records every request, answers `tool.start` / `tool.run`, and hands the
//! test the streaming run's notification route so the test can play the agent's
//! `tool.event` / `tool.done` stream (#3353, #3731).

use std::sync::{Arc, Mutex};
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

/// An agent that records requests and hands the test the run's notification
/// route, so the test plays the agent's `tool.event` / `tool.done` stream.
#[derive(Default)]
pub(crate) struct FakeAgent {
    /// Advertise `toolStreaming` (an agent at the network-tool floor, 0.9.0+).
    pub(crate) streaming: bool,
    /// Report no capabilities at all, as for an agent that is not connected.
    pub(crate) disconnected: bool,
    /// Refuse `tool.start` (e.g. the per-connection run limit).
    pub(crate) refuse_start: bool,
    /// The reply to a `tool.run` request; `None` answers `-32601`-style failure.
    pub(crate) tool_run_reply: Option<Value>,
    pub(crate) route: Mutex<Option<ToolRunSender>>,
    pub(crate) unregistered: Mutex<Vec<String>>,
    pub(crate) requests: Mutex<Vec<(String, Value)>>,
}

impl FakeAgent {
    pub(crate) fn streaming() -> Arc<Self> {
        Arc::new(Self {
            streaming: true,
            ..Self::default()
        })
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
        unimplemented!()
    }
    fn disconnect_agent(&self, agent_id: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn is_connected(&self, agent_id: &str) -> bool {
        true
    }
    fn get_capabilities(&self, agent_id: &str) -> Option<AgentCapabilities> {
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
            agent_version: "0.8.1".to_string(),
        })
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
        unimplemented!()
    }
    fn attach_session(&self, agent_id: &str, remote_session_id: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn close_session(&self, agent_id: &str, remote_session_id: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn list_sessions(&self, agent_id: &str) -> Result<Vec<AgentSessionInfo>, TerminalError> {
        unimplemented!()
    }
    fn list_connections_and_folders(
        &self,
        agent_id: &str,
    ) -> Result<AgentConnectionsData, TerminalError> {
        unimplemented!()
    }
    fn list_definitions(&self, agent_id: &str) -> Result<Vec<AgentDefinitionInfo>, TerminalError> {
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
        unimplemented!()
    }
    fn unregister_session_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn register_monitoring_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        monitoring_tx: MonitoringSender,
    ) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn unregister_monitoring_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn send_session_input(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        data: &[u8],
    ) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn resize_session(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn apply_agent_settings(
        &self,
        agent_id: &str,
        settings: &AgentSettings,
    ) -> Result<(), TerminalError> {
        unimplemented!()
    }
}

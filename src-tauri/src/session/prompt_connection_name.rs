//! The connection an SSH host-key prompt names when no terminal tab owns it
//! (#5943).
//!
//! A terminal tab's prompt is named by the tab's own title on the frontend
//! (#5862). A tunnel, an agent, the connection editor's Test — and a session's
//! own later SFTP, monitoring or process login — has no tab, so the connect itself names its connection by running in
//! [`with_prompt_connection_name`] scope; the host-key verifier puts the name
//! on the `ssh-host-key-prompt` event. These helpers build the names the
//! dialog shows, so the same host reached by a tunnel and by an agent reads
//! differently.

pub use termihub_core::backends::ssh::prompt_owner::{
    current_prompt_connection_name, with_prompt_connection_name, with_prompt_connection_name_sync,
};

/// The name a tunnel's host-key prompt shows: `"<tunnel> (tunnel)"`.
pub fn tunnel(name: &str) -> String {
    format!("{} (tunnel)", name.trim())
}

/// The name a remote agent's host-key prompt shows: `"<agent> (agent)"`.
pub fn agent(name: &str) -> String {
    format!("{} (agent)", name.trim())
}

/// Run `f` — a remote agent's blocking SSH connect — named after agent
/// `agent_name` (#5943). `None` runs it unnamed.
pub fn in_agent_scope_sync<R>(agent_name: Option<&str>, f: impl FnOnce() -> R) -> R {
    let name = agent_name.map(agent);
    with_prompt_connection_name_sync(name.as_deref(), f)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An agent's connect blocks on its `spawn_blocking` thread through
    /// `Handle::block_on`, inside the scope: its prompts name the agent.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_agent_connect_names_the_agent_for_its_prompts() {
        let seen = tokio::task::spawn_blocking(|| {
            in_agent_scope_sync(Some("build box"), || {
                tokio::runtime::Handle::current()
                    .block_on(async { current_prompt_connection_name() })
            })
        })
        .await
        .unwrap();
        assert_eq!(seen.as_deref(), Some("build box (agent)"));
        let unnamed = in_agent_scope_sync(None, current_prompt_connection_name);
        assert_eq!(unnamed, None);
    }

    #[test]
    fn names_say_what_asks() {
        assert_eq!(tunnel(" web "), "web (tunnel)");
        assert_eq!(agent("build box"), "build box (agent)");
    }
}

use std::collections::HashMap;
use std::sync::Arc;

use termihub_core::backends::ssh::handler::{ForwardedChannelRegistry, SshSession};

use crate::terminal::backend::SshConfig;
use crate::utils::errors::TerminalError;
use crate::utils::ssh_auth::connect_with_registry;

/// A pooled SSH session with a reference count.
struct PooledSession {
    session: Arc<SshSession>,
    registry: ForwardedChannelRegistry,
    ref_count: usize,
}

/// Shares SSH sessions across local and dynamic forwarding tunnels on the same SSH connection.
///
/// Sessions are wrapped in `Arc` so they can be shared across async tasks without cloning the
/// underlying `Handle`. Remote forwarding tunnels manage their own dedicated sessions.
pub struct SshSessionPool {
    sessions: HashMap<String, PooledSession>,
}

impl SshSessionPool {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    /// Get or create an SSH session for the given connection.
    ///
    /// If a session already exists for this connection ID, the reference count
    /// is incremented and the `Arc` is cloned. Otherwise, a new SSH connection
    /// is established and wrapped in `Arc`.
    pub fn get_or_create(
        &mut self,
        connection_id: &str,
        config: &SshConfig,
    ) -> Result<(Arc<SshSession>, ForwardedChannelRegistry), TerminalError> {
        if let Some(pooled) = self.sessions.get_mut(connection_id) {
            pooled.ref_count += 1;
            return Ok((Arc::clone(&pooled.session), pooled.registry.clone()));
        }

        let (session, registry) = connect_with_registry(config)?;
        let arc_session = Arc::new(session);

        self.sessions.insert(
            connection_id.to_string(),
            PooledSession {
                session: Arc::clone(&arc_session),
                registry: registry.clone(),
                ref_count: 1,
            },
        );

        Ok((arc_session, registry))
    }

    /// Release a reference to a pooled session.
    ///
    /// When the reference count reaches zero, the session is dropped
    /// and the SSH connection is closed.
    pub fn release(&mut self, connection_id: &str) {
        if let Some(pooled) = self.sessions.get_mut(connection_id) {
            pooled.ref_count = pooled.ref_count.saturating_sub(1);
            if pooled.ref_count == 0 {
                self.sessions.remove(connection_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_new_is_empty() {
        let pool = SshSessionPool::new();
        assert!(pool.sessions.is_empty());
    }

    #[test]
    fn release_nonexistent_connection_is_noop() {
        let mut pool = SshSessionPool::new();
        pool.release("nonexistent");
        assert!(pool.sessions.is_empty());
    }
}

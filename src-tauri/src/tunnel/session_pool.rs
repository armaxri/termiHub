use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use ssh2::Session;

use crate::terminal::backend::SshConfig;
use crate::utils::errors::TerminalError;
use crate::utils::ssh_auth::connect_and_authenticate;

/// A pooled SSH session with a reference count.
struct PooledSession {
    session: Arc<Mutex<Session>>,
    ref_count: usize,
}

/// Shares SSH sessions across tunnels using the same SSH connection.
///
/// Sessions are identified by connection ID. Multiple tunnels sharing the
/// same SSH connection will reuse a single `Session`, tracked by reference count.
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
    /// is incremented and the existing session is returned. Otherwise, a new
    /// SSH connection is established.
    pub fn get_or_create(
        &mut self,
        connection_id: &str,
        config: &SshConfig,
    ) -> Result<Arc<Mutex<Session>>, TerminalError> {
        if let Some(pooled) = self.sessions.get_mut(connection_id) {
            pooled.ref_count += 1;
            return Ok(Arc::clone(&pooled.session));
        }

        let session = connect_and_authenticate(config)?;
        let arc_session = Arc::new(Mutex::new(session));

        self.sessions.insert(
            connection_id.to_string(),
            PooledSession {
                session: Arc::clone(&arc_session),
                ref_count: 1,
            },
        );

        Ok(arc_session)
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

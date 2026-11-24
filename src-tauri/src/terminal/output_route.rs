//! Where the agent I/O task delivers one agent-hosted session's output, and
//! where in that output the agent last started over (#5990).
//!
//! Every attach of a daemon-backed session makes the agent send the session's
//! whole buffer again before live output goes on. The first chunk of it carries
//! a [`replay_id`], so whatever keeps the session's history knows that
//! everything before it comes once more — no matter which desktop action
//! attached the session.
//!
//! [`replay_id`]: termihub_core::protocol::methods::ConnectionOutputNotification::replay_id

use std::sync::{mpsc, Arc, Mutex, MutexGuard, PoisonError};

use termihub_core::connection::OutputReplay;

/// How much output a session's route received, and the last replay in it.
/// Clones share the state.
#[derive(Debug, Clone, Default)]
pub struct OutputPosition(Arc<Mutex<Received>>);

#[derive(Debug, Default)]
struct Received {
    bytes: u64,
    replay: Option<OutputReplay>,
}

impl OutputPosition {
    fn lock(&self) -> MutexGuard<'_, Received> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The agent's last replay in this route's output.
    pub fn replay(&self) -> Option<OutputReplay> {
        self.lock().replay
    }
}

/// Channel sender the agent I/O task delivers an agent-hosted session's output
/// on (#4416).
///
/// Deliberately **unbounded**, so the I/O task — which serves every session,
/// request and reply of one agent connection — never blocks and never drops a
/// chunk: a `send` only fails once the session's receiver is gone. Memory stays
/// bounded because the receiving side ([`RemoteProxy`]'s bridge into the
/// session's bounded output channel) applies backpressure, and a paused
/// terminal pauses the agent itself (`connection.output_flow`), so at most the
/// output already in flight when the pause landed queues here.
///
/// [`RemoteProxy`]: crate::session::remote_proxy::RemoteProxy
#[derive(Debug, Clone)]
pub struct OutputSender {
    tx: mpsc::Sender<Vec<u8>>,
    position: OutputPosition,
}

impl OutputSender {
    /// A route into `tx` that keeps `position` up to date.
    pub fn new(tx: mpsc::Sender<Vec<u8>>, position: OutputPosition) -> Self {
        Self { tx, position }
    }

    /// Deliver live output.
    pub fn send(&self, data: Vec<u8>) -> Result<(), mpsc::SendError<Vec<u8>>> {
        self.deliver(None, data)
    }

    /// Deliver the first chunk of replay `id` of the whole session buffer.
    pub fn send_replay_start(
        &self,
        id: u64,
        data: Vec<u8>,
    ) -> Result<(), mpsc::SendError<Vec<u8>>> {
        self.deliver(Some(id), data)
    }

    fn deliver(
        &self,
        replay_id: Option<u64>,
        data: Vec<u8>,
    ) -> Result<(), mpsc::SendError<Vec<u8>>> {
        // Counted before it is delivered, so a reader that has the bytes sees
        // them counted. Only the agent's I/O task sends.
        {
            let mut received = self.position.lock();
            if let Some(id) = replay_id {
                received.replay = Some(OutputReplay {
                    id,
                    start: received.bytes,
                });
            }
            received.bytes += data.len() as u64;
        }
        self.tx.send(data)
    }
}

impl From<mpsc::Sender<Vec<u8>>> for OutputSender {
    fn from(tx: mpsc::Sender<Vec<u8>>) -> Self {
        Self::new(tx, OutputPosition::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_replay_starts_after_everything_delivered_before_it() {
        let (tx, rx) = mpsc::channel();
        let position = OutputPosition::default();
        let route = OutputSender::new(tx, position.clone());
        route.send(b"abc".to_vec()).unwrap();
        assert_eq!(position.replay(), None);

        route.send_replay_start(5, b"abcd".to_vec()).unwrap();
        route.send(b"e".to_vec()).unwrap();
        assert_eq!(position.replay(), Some(OutputReplay { id: 5, start: 3 }));

        // The next one, from a clone, counts on.
        route
            .clone()
            .send_replay_start(6, b"abcde".to_vec())
            .unwrap();
        assert_eq!(position.replay(), Some(OutputReplay { id: 6, start: 8 }));
        drop(route);
        assert_eq!(rx.iter().collect::<Vec<_>>().concat(), b"abcabcdeabcde");
    }

    #[test]
    fn a_replay_at_the_start_is_a_replay() {
        let (tx, _rx) = mpsc::channel();
        let position = OutputPosition::default();
        let route = OutputSender::new(tx, position.clone());
        route.send_replay_start(1, b"x".to_vec()).unwrap();
        assert_eq!(position.replay(), Some(OutputReplay { id: 1, start: 0 }));
    }

    #[test]
    fn a_gone_receiver_is_an_error() {
        let (tx, rx) = mpsc::channel();
        drop(rx);
        assert!(OutputSender::from(tx).send(b"x".to_vec()).is_err());
    }
}

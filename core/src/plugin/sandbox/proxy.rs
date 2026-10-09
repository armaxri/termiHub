//! Host side of a **proxied** bridge connection (#4183): the fallback where a
//! connected socket cannot be handed to the runner (on Windows a socket that
//! is not a kernel handle, or a failed `DuplicateHandle`, #4219; the forced
//! relay of tests). The host keeps the socket and relays its bytes:
//!
//! * **socket → runner:** a pump thread reads the socket and sends
//!   `StreamData`, never more than [`STREAM_WINDOW`] bytes ahead of the
//!   runner's `StreamAck`s; end of stream (or a read error) sends
//!   `StreamClosed`.
//! * **runner → socket:** `StreamWrite` chunks queue here (a runner that
//!   overruns the window is a protocol violation) and a writer thread writes
//!   them, answering each with a `StreamWriteAck`.
//!
//! [`ProxyHost::close`] shuts the socket down, which ends both threads.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::{Arc, Condvar, Mutex};

use termihub_plugin_runner::ipc::{ConnRef, Message, StreamAck, StreamChunk, STREAM_WINDOW};

/// Largest `StreamData` chunk the pump sends.
const PUMP_CHUNK: usize = 64 * 1024;

/// Sends one frame to the runner; `false` when the channel failed (the caller
/// stops, the runner is being killed).
pub(super) type FrameSink = Arc<dyn Fn(&Message) -> bool + Send + Sync>;

/// One proxied connection.
pub(super) struct ProxyHost {
    conn_id: u64,
    stream: TcpStream,
    /// `StreamData` bytes sent but not yet acknowledged by the runner.
    unacked: Mutex<usize>,
    credit: Condvar,
    writes: Mutex<WriteQueue>,
    queued: Condvar,
    closed: std::sync::atomic::AtomicBool,
    /// `StreamClosed` was sent to the runner.
    closed_reported: std::sync::atomic::AtomicBool,
}

#[derive(Default)]
struct WriteQueue {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    closed: bool,
}

impl ProxyHost {
    /// Wrap a connected socket.
    pub(super) fn new(conn_id: u64, stream: TcpStream) -> Arc<Self> {
        Arc::new(Self {
            conn_id,
            stream,
            unacked: Mutex::new(0),
            credit: Condvar::new(),
            writes: Mutex::new(WriteQueue::default()),
            queued: Condvar::new(),
            closed: std::sync::atomic::AtomicBool::new(false),
            closed_reported: std::sync::atomic::AtomicBool::new(false),
        })
    }

    /// Start the pump and writer threads (after the runner has the reply).
    ///
    /// If either cannot start, the connection would never move data: it is
    /// closed instead and the runner is told so (`StreamClosed`, #4335).
    pub(super) fn start(self: &Arc<Self>, sink: FrameSink) {
        let pump = Arc::clone(self);
        let pump_sink = Arc::clone(&sink);
        let started =
            super::threads::spawn(format!("plugin-bridge-pump-{}", self.conn_id), move || {
                pump.pump(&pump_sink)
            })
            .and_then(|()| {
                let writer = Arc::clone(self);
                let writer_sink = Arc::clone(&sink);
                super::threads::spawn(format!("plugin-bridge-write-{}", self.conn_id), move || {
                    writer.drain(&writer_sink)
                })
            });
        if let Err(e) = started {
            tracing::error!(
                target: crate::plugin::PLUGIN_LOG_TARGET,
                "bridge connection {}: starting its relay thread failed ({e}); closing it",
                self.conn_id
            );
            self.close();
            self.report_closed(&sink);
        }
    }

    /// Tell the runner the connection ended (`StreamClosed`), at most once.
    fn report_closed(&self, sink: &FrameSink) {
        if !self
            .closed_reported
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            let _ = sink(&Message::StreamClosed(ConnRef {
                conn_id: self.conn_id,
            }));
        }
    }

    /// The runner consumed `bytes` of `StreamData`. `Err` if it acknowledges
    /// more than was sent (a violation).
    pub(super) fn ack(&self, bytes: usize) -> Result<(), String> {
        let mut unacked = self.unacked.lock().unwrap_or_else(|e| e.into_inner());
        if bytes > *unacked {
            return Err(format!(
                "StreamAck of {bytes} bytes with {} outstanding on connection {}",
                *unacked, self.conn_id
            ));
        }
        *unacked -= bytes;
        self.credit.notify_all();
        Ok(())
    }

    /// Queue runner bytes for the socket. `Err` if the runner overran its
    /// window (a violation).
    pub(super) fn write(&self, data: Vec<u8>) -> Result<(), String> {
        let mut queue = self.writes.lock().unwrap_or_else(|e| e.into_inner());
        if queue.bytes + data.len() > STREAM_WINDOW {
            return Err(format!(
                "StreamWrite overran the {STREAM_WINDOW}-byte window on connection {}",
                self.conn_id
            ));
        }
        if queue.closed || data.is_empty() {
            return Ok(());
        }
        queue.bytes += data.len();
        queue.chunks.push_back(data);
        self.queued.notify_all();
        Ok(())
    }

    /// Close the socket and end both threads. Idempotent.
    pub(super) fn close(&self) {
        self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = self.stream.shutdown(Shutdown::Both);
        self.writes.lock().unwrap_or_else(|e| e.into_inner()).closed = true;
        self.queued.notify_all();
        self.credit.notify_all();
    }

    fn is_closed(&self) -> bool {
        self.closed.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// socket → runner, within the credit window.
    fn pump(&self, sink: &FrameSink) {
        let mut buf = vec![0u8; PUMP_CHUNK];
        let mut reader = &self.stream;
        loop {
            let room = {
                let mut unacked = self.unacked.lock().unwrap_or_else(|e| e.into_inner());
                while *unacked >= STREAM_WINDOW && !self.is_closed() {
                    unacked = self.credit.wait(unacked).unwrap_or_else(|e| e.into_inner());
                }
                STREAM_WINDOW - *unacked
            };
            if self.is_closed() {
                return;
            }
            let want = room.min(PUMP_CHUNK);
            let n = match reader.read(&mut buf[..want]) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            *self.unacked.lock().unwrap_or_else(|e| e.into_inner()) += n;
            let chunk = Message::StreamData(StreamChunk {
                conn_id: self.conn_id,
                data: buf[..n].to_vec(),
            });
            if !sink(&chunk) {
                return;
            }
        }
        if !self.is_closed() {
            self.report_closed(sink);
        }
    }

    /// runner → socket, acknowledging each chunk.
    fn drain(&self, sink: &FrameSink) {
        let mut writer = &self.stream;
        let mut failed = false;
        loop {
            let chunk = {
                let mut queue = self.writes.lock().unwrap_or_else(|e| e.into_inner());
                while queue.chunks.is_empty() && !queue.closed {
                    queue = self.queued.wait(queue).unwrap_or_else(|e| e.into_inner());
                }
                match queue.chunks.pop_front() {
                    Some(chunk) => {
                        queue.bytes -= chunk.len();
                        chunk
                    }
                    None => return,
                }
            };
            if !failed && writer.write_all(&chunk).is_err() {
                failed = true;
            }
            let ack = Message::StreamWriteAck(StreamAck {
                conn_id: self.conn_id,
                bytes: u32::try_from(chunk.len()).unwrap_or(u32::MAX),
                failed,
            });
            if !sink(&ack) {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::time::Duration;

    fn pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let a = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (b, _) = listener.accept().unwrap();
        (a, b)
    }

    fn recording_sink() -> (FrameSink, mpsc::Receiver<Message>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let sink: FrameSink =
            Arc::new(move |m: &Message| tx.lock().unwrap().send(m.clone()).is_ok());
        (sink, rx)
    }

    #[test]
    fn bytes_flow_both_ways_and_eof_is_reported() {
        let (host_side, mut peer) = pair();
        let proxy = ProxyHost::new(5, host_side);
        let (sink, frames) = recording_sink();
        proxy.start(sink);

        peer.write_all(b"from peer").unwrap();
        match frames.recv_timeout(Duration::from_secs(5)).unwrap() {
            Message::StreamData(chunk) => {
                assert_eq!(chunk.conn_id, 5);
                assert_eq!(chunk.data, b"from peer");
            }
            other => panic!("expected StreamData, got {other:?}"),
        }
        proxy.ack(9).unwrap();

        proxy.write(b"to peer".to_vec()).unwrap();
        match frames.recv_timeout(Duration::from_secs(5)).unwrap() {
            Message::StreamWriteAck(ack) => {
                assert_eq!((ack.conn_id, ack.bytes, ack.failed), (5, 7, false));
            }
            other => panic!("expected StreamWriteAck, got {other:?}"),
        }
        let mut got = [0u8; 7];
        peer.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"to peer");

        drop(peer);
        match frames.recv_timeout(Duration::from_secs(5)).unwrap() {
            Message::StreamClosed(c) => assert_eq!(c.conn_id, 5),
            other => panic!("expected StreamClosed, got {other:?}"),
        }
        proxy.close();
    }

    #[test]
    fn a_relay_thread_that_cannot_start_closes_the_connection() {
        for thread in ["plugin-bridge-pump", "plugin-bridge-write"] {
            let (host_side, mut peer) = pair();
            let proxy = ProxyHost::new(9, host_side);
            let (sink, frames) = recording_sink();
            {
                let _fail = crate::plugin::sandbox::threads::fail_spawns_named(thread);
                proxy.start(sink);
            }
            match frames.recv_timeout(Duration::from_secs(5)).unwrap() {
                Message::StreamClosed(c) => assert_eq!(c.conn_id, 9, "{thread}"),
                other => panic!("{thread}: expected StreamClosed, got {other:?}"),
            }
            assert!(proxy.is_closed(), "{thread}");
            // The socket was shut down: the far end sees end of stream.
            peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut buf = [0u8; 8];
            assert_eq!(peer.read(&mut buf).unwrap(), 0, "{thread}");
            // Exactly one StreamClosed.
            assert!(frames.recv_timeout(Duration::from_millis(200)).is_err());
        }
    }

    #[test]
    fn overrunning_the_window_or_over_acking_is_a_violation() {
        let (host_side, _peer) = pair();
        let proxy = ProxyHost::new(1, host_side);
        // No writer thread started: the queue only fills.
        proxy.write(vec![0; STREAM_WINDOW]).unwrap();
        assert!(proxy.write(vec![0; 1]).is_err());
        assert!(proxy.ack(1).is_err(), "nothing was sent yet");
        proxy.close();
    }

    #[test]
    fn the_pump_stops_at_the_window_until_acknowledged() {
        let (host_side, mut peer) = pair();
        let proxy = ProxyHost::new(2, host_side);
        let (sink, frames) = recording_sink();
        proxy.start(sink);
        let blob = vec![7u8; STREAM_WINDOW + 4096];
        let writer = std::thread::spawn(move || {
            peer.write_all(&blob).unwrap();
            peer
        });
        let mut received = 0;
        while received < STREAM_WINDOW {
            match frames.recv_timeout(Duration::from_secs(5)).unwrap() {
                Message::StreamData(chunk) => received += chunk.data.len(),
                other => panic!("unexpected {other:?}"),
            }
        }
        assert_eq!(received, STREAM_WINDOW);
        assert!(
            frames.recv_timeout(Duration::from_millis(200)).is_err(),
            "no more data before an ack"
        );
        proxy.ack(STREAM_WINDOW).unwrap();
        let mut rest = 0;
        while rest < 4096 {
            match frames.recv_timeout(Duration::from_secs(5)).unwrap() {
                Message::StreamData(chunk) => rest += chunk.data.len(),
                other => panic!("unexpected {other:?}"),
            }
        }
        assert_eq!(rest, 4096);
        let _peer = writer.join().unwrap();
        proxy.close();
    }
}

//! Two-class notification queue for the transport loop (#4480).
//!
//! Every backend task emits notifications into one
//! [`NotificationSender`](super::transport::NotificationSender). Most of them
//! are small and latency-sensitive: terminal output (`connection.output`),
//! session/state changes, `agent.forward.ack` credit. Port-forward stream data
//! (`agent.forward.data`, VNC/RDP over an agent) is bulk: a busy remote desktop
//! can queue a whole flow-control window (up to 512 KiB, #4284) per stream.
//! Written in plain arrival order, that window sits ahead of every terminal
//! session's next output line.
//!
//! [`NotificationQueues`] sorts what the loop pulls from the channel into two
//! FIFOs and picks the next one to write:
//!
//! - **Normal** — everything except forward stream data/close. Served first.
//! - **Bulk** — `agent.forward.data` and `agent.forward.close` notifications.
//!   Served when the normal queue is empty, and also after every
//!   [`BULK_EVERY`] consecutive normal writes, so sustained terminal output
//!   never starves a forward stream.
//!
//! A stream's `close` rides the bulk queue with its data so it can never
//! overtake that stream's last bytes; one FIFO keeps per-stream order.
//! `agent.forward.open` and `agent.forward.ack` stay on the normal queue: an
//! open is emitted before any data of its stream, and acks must stay prompt so
//! the desktop's window refills.
//!
//! Notifications are moved, never copied, so a release guard (#4439) stays
//! attached and is dropped exactly when the notification is written — or when
//! the queues are dropped with the connection.

use std::collections::VecDeque;

use crate::protocol::messages::JsonRpcNotification;
use crate::protocol::methods::{AGENT_FORWARD_CLOSE, AGENT_FORWARD_DATA};

/// After this many normal notifications written back to back while bulk data
/// waits, one bulk notification is written. Bounds how long a forward stream
/// waits under sustained terminal output (no starvation) while keeping it at
/// most a 1-in-`BULK_EVERY + 1` share of the link when both classes are busy.
pub const BULK_EVERY: usize = 4;

/// Whether `notification` belongs on the low-priority bulk queue.
fn is_bulk(notification: &JsonRpcNotification) -> bool {
    notification.method == AGENT_FORWARD_DATA || notification.method == AGENT_FORWARD_CLOSE
}

/// The transport loop's pending notifications, split into a normal and a bulk
/// FIFO (see the [module docs](self)).
#[derive(Default)]
pub struct NotificationQueues {
    normal: VecDeque<JsonRpcNotification>,
    bulk: VecDeque<JsonRpcNotification>,
    /// Normal notifications written in a row while bulk data was waiting.
    normal_streak: usize,
}

impl NotificationQueues {
    /// Queue a notification on the class its method belongs to.
    pub fn push(&mut self, notification: JsonRpcNotification) {
        if is_bulk(&notification) {
            self.bulk.push_back(notification);
        } else {
            self.normal.push_back(notification);
        }
    }

    /// Whether nothing is queued.
    pub fn is_empty(&self) -> bool {
        self.normal.is_empty() && self.bulk.is_empty()
    }

    /// Take the next notification to write: normal first, bulk when the normal
    /// queue is empty or after [`BULK_EVERY`] normal writes in a row.
    pub fn pop(&mut self) -> Option<JsonRpcNotification> {
        if self.bulk.is_empty() {
            self.normal_streak = 0;
            return self.normal.pop_front();
        }
        if self.normal.is_empty() || self.normal_streak >= BULK_EVERY {
            self.normal_streak = 0;
            return self.bulk.pop_front();
        }
        self.normal_streak += 1;
        self.normal.pop_front()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::methods::AGENT_FORWARD_ACK;
    use serde_json::json;
    use std::sync::Arc;

    fn output(seq: u64) -> JsonRpcNotification {
        JsonRpcNotification::new("connection.output", json!({"seq": seq}))
    }

    fn data(stream: &str, seq: u64) -> JsonRpcNotification {
        JsonRpcNotification::new(AGENT_FORWARD_DATA, json!({"stream_id": stream, "seq": seq}))
    }

    fn close(stream: &str) -> JsonRpcNotification {
        JsonRpcNotification::new(AGENT_FORWARD_CLOSE, json!({"stream_id": stream}))
    }

    fn drain(q: &mut NotificationQueues) -> Vec<(String, serde_json::Value)> {
        std::iter::from_fn(|| q.pop())
            .map(|n| (n.method, n.params))
            .collect()
    }

    #[test]
    fn terminal_output_overtakes_queued_forward_data() {
        let mut q = NotificationQueues::default();
        for i in 0..8 {
            q.push(data("s", i));
        }
        q.push(output(0));
        let first = q.pop().expect("queued");
        assert_eq!(first.method, "connection.output");
    }

    #[test]
    fn acks_and_opens_stay_on_the_normal_queue() {
        let mut q = NotificationQueues::default();
        q.push(data("s", 0));
        q.push(JsonRpcNotification::new(
            AGENT_FORWARD_ACK,
            json!({"stream_id": "s", "bytes": 1}),
        ));
        q.push(JsonRpcNotification::new(
            crate::protocol::methods::AGENT_FORWARD_OPEN,
            json!({"stream_id": "t"}),
        ));
        let order: Vec<String> = drain(&mut q).into_iter().map(|(m, _)| m).collect();
        assert_eq!(
            order,
            vec![
                AGENT_FORWARD_ACK.to_string(),
                crate::protocol::methods::AGENT_FORWARD_OPEN.to_string(),
                AGENT_FORWARD_DATA.to_string(),
            ]
        );
    }

    #[test]
    fn forward_data_is_not_starved_by_sustained_output() {
        let mut q = NotificationQueues::default();
        q.push(data("s", 0));
        q.push(data("s", 1));
        // Keep the normal queue non-empty the whole time, as sustained
        // terminal output would.
        let mut seq = 0;
        for _ in 0..=BULK_EVERY {
            q.push(output(seq));
            seq += 1;
        }
        let mut bulk_positions = Vec::new();
        for pos in 0..3 * (BULK_EVERY + 1) {
            let n = q.pop().expect("normal queue never empties");
            if n.method == AGENT_FORWARD_DATA {
                bulk_positions.push(pos);
            }
            q.push(output(seq));
            seq += 1;
        }
        assert_eq!(bulk_positions, vec![BULK_EVERY, 2 * BULK_EVERY + 1]);
    }

    #[test]
    fn data_and_close_of_a_stream_stay_in_order() {
        let mut q = NotificationQueues::default();
        q.push(data("a", 0));
        q.push(output(0));
        q.push(data("a", 1));
        q.push(data("b", 0));
        q.push(close("a"));
        q.push(output(1));
        q.push(close("b"));
        let bulk: Vec<(String, serde_json::Value)> = drain(&mut q)
            .into_iter()
            .filter(|(m, _)| m != "connection.output")
            .collect();
        assert_eq!(
            bulk,
            vec![
                (
                    AGENT_FORWARD_DATA.to_string(),
                    json!({"stream_id": "a", "seq": 0})
                ),
                (
                    AGENT_FORWARD_DATA.to_string(),
                    json!({"stream_id": "a", "seq": 1})
                ),
                (
                    AGENT_FORWARD_DATA.to_string(),
                    json!({"stream_id": "b", "seq": 0})
                ),
                (AGENT_FORWARD_CLOSE.to_string(), json!({"stream_id": "a"})),
                (AGENT_FORWARD_CLOSE.to_string(), json!({"stream_id": "b"})),
            ]
        );
    }

    /// #4439's release guard rides along in either queue and is released only
    /// when the notification leaves (popped and dropped) or the queues drop.
    #[test]
    fn release_guards_drop_with_their_notification_in_both_queues() {
        let normal_guard: Arc<()> = Arc::new(());
        let bulk_guard: Arc<()> = Arc::new(());
        let mut q = NotificationQueues::default();
        q.push(output(0).with_release_guard(normal_guard.clone()));
        q.push(data("s", 0).with_release_guard(bulk_guard.clone()));
        assert_eq!(Arc::strong_count(&normal_guard), 2);
        assert_eq!(Arc::strong_count(&bulk_guard), 2);

        let first = q.pop().expect("normal");
        assert_eq!(Arc::strong_count(&normal_guard), 2, "held until written");
        drop(first);
        assert_eq!(Arc::strong_count(&normal_guard), 1);

        assert_eq!(Arc::strong_count(&bulk_guard), 2, "queued bulk still held");
        drop(q);
        assert_eq!(
            Arc::strong_count(&bulk_guard),
            1,
            "dropping the queues releases"
        );
    }
}

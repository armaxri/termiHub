//! Tests for the bounded, prioritized agent I/O command path (#3018).
//!
//! The lane tests drive the real [`IoLanes`] / [`IoBudget`] / [`AgentIoSender`]
//! the I/O task uses, with a simulated writer standing in for the russh channel;
//! the manager tests go through [`AgentConnectionManager`]'s public producers.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;

use super::*;
use crate::terminal::agent_manager::{
    AgentCapabilities, AgentConnection, AgentConnectionManager, AgentIoCommand, AgentRpcFailure,
};

// ── Helpers ──────────────────────────────────────────────────────────

fn input(session: &str, data: &[u8]) -> AgentIoCommand {
    AgentIoCommand::SessionInput {
        session_id: session.to_string(),
        data: data.to_vec(),
    }
}

fn numbered_input(n: usize) -> AgentIoCommand {
    input("s", format!("{n:08}").as_bytes())
}

fn input_number(cmd: &AgentIoCommand) -> Option<usize> {
    match cmd {
        AgentIoCommand::SessionInput { data, .. } => std::str::from_utf8(data).ok()?.parse().ok(),
        _ => None,
    }
}

type ResponseRx = tokio::sync::oneshot::Receiver<Result<serde_json::Value, AgentRpcFailure>>;

fn request() -> (AgentIoCommand, ResponseRx) {
    let (response_tx, response_rx) = tokio::sync::oneshot::channel();
    (
        AgentIoCommand::Request {
            method: "connection.close".to_string(),
            params: serde_json::json!({}),
            response_tx,
        },
        response_rx,
    )
}

fn label(cmd: &AgentIoCommand) -> String {
    match cmd {
        AgentIoCommand::SessionInput { data, .. } => {
            format!("input:{}", String::from_utf8_lossy(data))
        }
        AgentIoCommand::SessionResize { cols, rows, .. } => format!("resize:{cols}x{rows}"),
        AgentIoCommand::AgentForwardData { data, .. } => {
            format!("fwd:{}", String::from_utf8_lossy(data))
        }
        AgentIoCommand::AgentForwardClose { stream_id } => format!("fwd-close:{stream_id}"),
        AgentIoCommand::Request { method, .. } => format!("request:{method}"),
        AgentIoCommand::UnregisterSession { session_id } => format!("unregister:{session_id}"),
        AgentIoCommand::Disconnect => "disconnect".to_string(),
        _ => "other".to_string(),
    }
}

/// A gated sender plus the lanes that drain it, sharing one budget.
fn pipe(capacity: usize) -> (AgentIoSender, IoLanes, Arc<IoBudget>, Arc<AtomicBool>) {
    let (tx, rx) = mpsc::unbounded_channel::<AgentIoCommand>();
    let budget = IoBudget::new(capacity);
    let reconnecting = Arc::new(AtomicBool::new(false));
    let sender = AgentIoSender::new(tx, budget.clone(), reconnecting.clone());
    (
        sender,
        IoLanes::new(rx, budget.clone()),
        budget,
        reconnecting,
    )
}

/// Cost of one `numbered_input` command.
fn numbered_cost() -> usize {
    data_cost(&numbered_input(0))
}

// ── Classification ───────────────────────────────────────────────────

#[test]
fn lanes_classify_data_and_control() {
    let cmd = input("sess", b"abc");
    assert_eq!(
        lane_of(&cmd),
        Lane::Data {
            cost: 3 + "sess".len() + AGENT_IO_ITEM_OVERHEAD
        }
    );
    let fwd = AgentIoCommand::AgentForwardData {
        stream_id: "st".to_string(),
        data: vec![0; 10],
    };
    assert_eq!(data_cost(&fwd), 10 + 2 + AGENT_IO_ITEM_OVERHEAD);

    // Ordered with data, but never waits for credit.
    let resize = AgentIoCommand::SessionResize {
        session_id: "sess".to_string(),
        cols: 80,
        rows: 24,
    };
    assert_eq!(lane_of(&resize), Lane::Data { cost: 0 });
    let close = AgentIoCommand::AgentForwardClose {
        stream_id: "st".to_string(),
    };
    assert_eq!(lane_of(&close), Lane::Data { cost: 0 });

    // Control: never gated, served ahead of data.
    assert_eq!(lane_of(&AgentIoCommand::Disconnect), Lane::Control);
    assert_eq!(lane_of(&request().0), Lane::Control);
    let unregister = AgentIoCommand::UnregisterSession {
        session_id: "sess".to_string(),
    };
    assert_eq!(lane_of(&unregister), Lane::Control);
}

// ── Flood: bounded memory, every byte, in order ──────────────────────

/// A flood of input far larger than the budget, drained by a slow writer:
/// the queued backlog never exceeds the budget, and every command arrives
/// exactly once, in order.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn flood_stays_bounded_and_arrives_in_order() {
    const TOTAL: usize = 5_000;
    let capacity = 16 * numbered_cost();
    let (sender, mut lanes, budget, _reconnecting) = pipe(capacity);
    let bound = capacity / numbered_cost();

    let producer = tokio::spawn(async move {
        for n in 0..TOTAL {
            sender.send(numbered_input(n)).await.expect("gated send");
        }
    });

    let mut received = Vec::with_capacity(TOTAL);
    let mut max_backlog = 0;
    while received.len() < TOTAL {
        match lanes.next_command().await {
            Next::Data(cmd, credit) => {
                // Everything still queued — ingress + data lane — plus the one
                // in hand never exceeds what the budget can hold.
                max_backlog = max_backlog.max(lanes.backlog() + 1);
                assert!(lanes.backlog() < bound, "backlog exceeded the budget");
                // A slow link: every write yields before completing.
                tokio::task::yield_now().await;
                received.push(input_number(&cmd).expect("numbered input"));
                drop(credit);
            }
            Next::Control(_) => panic!("only data was sent"),
            Next::Closed => panic!("sender still alive"),
        }
    }
    producer.await.expect("producer");

    assert_eq!(
        received,
        (0..TOTAL).collect::<Vec<_>>(),
        "all input, in order"
    );
    assert!(
        max_backlog <= bound,
        "max backlog {max_backlog} > bound {bound}"
    );
    assert!(
        max_backlog > 1,
        "the flood must actually have filled the queue for this test to mean anything"
    );
    assert_eq!(budget.in_use(), 0, "every credit returned");
}

/// The same flood, from the synchronous `send_blocking` path used by terminal
/// writes, on real threads.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn blocking_flood_stays_bounded_and_arrives_in_order() {
    const TOTAL: usize = 2_000;
    let capacity = 8 * numbered_cost();
    let (sender, mut lanes, budget, _reconnecting) = pipe(capacity);

    let producer = tokio::task::spawn_blocking(move || {
        for n in 0..TOTAL {
            sender.send_blocking(numbered_input(n)).expect("gated send");
        }
    });

    let mut received = Vec::with_capacity(TOTAL);
    while received.len() < TOTAL {
        if let Next::Data(cmd, credit) = lanes.next_command().await {
            assert!(budget.in_use() <= capacity);
            received.push(input_number(&cmd).expect("numbered input"));
            drop(credit);
        }
    }
    producer.await.expect("producer");
    assert_eq!(received, (0..TOTAL).collect::<Vec<_>>());
    assert_eq!(budget.in_use(), 0);
}

/// Under a paused clock (timer-driven slow writer, auto-advancing time), a
/// flood with a concurrent control sender completes: nothing in the gate
/// depends on wall-clock time, so it cannot deadlock. A deadlock would idle
/// the runtime and auto-advance straight to the outer timeout.
#[tokio::test(start_paused = true)]
async fn no_deadlock_under_paused_clock() {
    const TOTAL: usize = 500;
    let (sender, mut lanes, budget, _reconnecting) = pipe(4 * numbered_cost());

    let run = async {
        let data_sender = sender.clone();
        let producer = tokio::spawn(async move {
            for n in 0..TOTAL {
                data_sender
                    .send(numbered_input(n))
                    .await
                    .expect("gated send");
            }
        });
        let control_sender = sender.clone();
        let controller = tokio::spawn(async move {
            for _ in 0..10 {
                tokio::time::sleep(Duration::from_millis(7)).await;
                control_sender
                    .send(AgentIoCommand::UnregisterSession {
                        session_id: "s".to_string(),
                    })
                    .await
                    .expect("control send");
            }
        });

        let (mut data, mut control) = (Vec::new(), 0);
        while data.len() < TOTAL || control < 10 {
            match lanes.next_command().await {
                Next::Data(cmd, credit) => {
                    tokio::time::sleep(Duration::from_millis(1)).await; // slow write
                    data.push(input_number(&cmd).expect("numbered"));
                    drop(credit);
                }
                Next::Control(_) => control += 1,
                Next::Closed => panic!("sender alive"),
            }
        }
        producer.await.expect("producer");
        controller.await.expect("controller");
        data
    };
    let data = tokio::time::timeout(Duration::from_secs(3600), run)
        .await
        .expect("flood + control must complete under a paused clock");
    assert_eq!(data, (0..TOTAL).collect::<Vec<_>>());
    assert_eq!(budget.in_use(), 0);
}

// ── Control is never blocked behind data ─────────────────────────────

/// With the data budget exhausted and a producer parked waiting for credit,
/// control commands still enqueue immediately and are served ahead of every
/// queued data command.
#[tokio::test(start_paused = true)]
async fn control_goes_through_while_data_queue_is_full() {
    let (sender, mut lanes, budget, _reconnecting) = pipe(3 * numbered_cost());
    for n in 0..3 {
        sender.send(numbered_input(n)).await.expect("fits");
    }
    assert_eq!(budget.in_use(), budget.capacity(), "budget exhausted");

    // A fourth write must wait for credit.
    let blocked = {
        let sender = sender.clone();
        tokio::spawn(async move { sender.send(numbered_input(3)).await })
    };
    tokio::task::yield_now().await;
    assert!(
        !blocked.is_finished(),
        "data backpressures on a full budget"
    );
    assert_eq!(budget.waiters(), 1);

    // Control sends never wait, even now.
    let (req, _response_rx) = request();
    tokio::time::timeout(Duration::from_millis(1), sender.send(req))
        .await
        .expect("a request is never blocked by a full data budget")
        .expect("send");
    tokio::time::timeout(
        Duration::from_millis(1),
        sender.send(AgentIoCommand::Disconnect),
    )
    .await
    .expect("disconnect is never blocked by a full data budget")
    .expect("send");

    // …and are served before any of the queued data.
    let first = match lanes.next_command().await {
        Next::Control(c) => label(&c),
        _ => panic!("control must overtake queued data"),
    };
    let second = match lanes.next_command().await {
        Next::Control(c) => label(&c),
        _ => panic!("control must overtake queued data"),
    };
    assert_eq!(first, "request:connection.close");
    assert_eq!(second, "disconnect");
    assert_eq!(
        lanes.queued_data(),
        3,
        "the data is still queued, untouched"
    );

    // Serving one data command frees the waiting producer.
    match lanes.next_command().await {
        Next::Data(cmd, credit) => {
            assert_eq!(input_number(&cmd), Some(0));
            drop(credit);
        }
        _ => panic!("expected the oldest data"),
    }
    blocked
        .await
        .expect("join")
        .expect("admitted once credit frees");
}

/// When the I/O task ends (its budget closes — `Disconnect`, abort, exhausted
/// reconnect) every producer waiting for credit fails promptly, async and
/// blocking alike, instead of waiting forever.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_fails_waiting_producers() {
    let (sender, lanes, budget, _reconnecting) = pipe(numbered_cost());
    sender.send(numbered_input(0)).await.expect("fits");

    let async_waiter = {
        let sender = sender.clone();
        tokio::spawn(async move { sender.send(numbered_input(1)).await })
    };
    let blocking_waiter = {
        let sender = sender.clone();
        tokio::task::spawn_blocking(move || sender.send_blocking(numbered_input(2)))
    };
    while budget.waiters() < 2 {
        tokio::task::yield_now().await;
    }

    // The I/O task's drop guard runs however the task ends.
    drop(CloseBudgetOnDrop(budget.clone()));
    drop(lanes);

    let a = tokio::time::timeout(Duration::from_secs(5), async_waiter)
        .await
        .expect("async waiter released")
        .expect("join");
    let b = tokio::time::timeout(Duration::from_secs(5), blocking_waiter)
        .await
        .expect("blocking waiter released")
        .expect("join");
    assert_eq!(a, Err(GateError::Closed));
    assert_eq!(b, Err(GateError::Closed));
    assert!(budget.is_closed());
    // Later sends fail at once too.
    assert_eq!(sender.send(numbered_input(3)).await, Err(GateError::Closed));
}

// ── Reconnect during a full queue ────────────────────────────────────

/// The transport breaks while the data queue is full and producers wait:
/// the waiters give up (input is dropped per CONC-014), the post-reconnect
/// backlog drop releases the dropped input's credit, survivors keep theirs and
/// re-queue through the ingress without waiting (no self-deadlock), and the
/// resumed loop serves them in order and returns every credit.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reconnect_with_full_queue_neither_deadlocks_nor_leaks() {
    let fwd = |s: &str| AgentIoCommand::AgentForwardData {
        stream_id: "st".to_string(),
        data: s.as_bytes().to_vec(),
    };
    let capacity = 2 * numbered_cost() + data_cost(&fwd("a")) + data_cost(&fwd("b"));
    let (sender, mut lanes, budget, reconnecting) = pipe(capacity);
    // The I/O task's own (ungated) handle on its ingress.
    let tx = sender.tx.clone();

    sender.send(numbered_input(0)).await.expect("fits");
    sender.send(fwd("a")).await.expect("fits");
    sender
        .send(AgentIoCommand::SessionResize {
            session_id: "s".to_string(),
            cols: 80,
            rows: 24,
        })
        .await
        .expect("ungated");
    sender.send(numbered_input(1)).await.expect("fits");
    sender.send(fwd("b")).await.expect("fits");
    sender
        .send(AgentIoCommand::AgentForwardClose {
            stream_id: "st".to_string(),
        })
        .await
        .expect("ungated");
    assert_eq!(budget.in_use(), capacity, "queue full");

    // Move part of the backlog into the data lane, as the running loop would.
    let (req, _rx) = request();
    sender.send(req).await.expect("control");
    match lanes.next_command().await {
        Next::Control(c) => assert_eq!(label(&c), "request:connection.close"),
        _ => panic!("control first"),
    }

    let async_waiter = {
        let sender = sender.clone();
        tokio::spawn(async move { sender.send(numbered_input(2)).await })
    };
    let blocking_waiter = {
        let sender = sender.clone();
        tokio::task::spawn_blocking(move || sender.send_blocking(numbered_input(3)))
    };
    while budget.waiters() < 2 {
        tokio::task::yield_now().await;
    }

    // Transport breaks: the I/O task flags the outage and interrupts waiters.
    reconnecting.store(true, Ordering::SeqCst);
    budget.interrupt();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), async_waiter)
            .await
            .expect("async waiter released")
            .expect("join"),
        Err(GateError::Reconnecting)
    );
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), blocking_waiter)
            .await
            .expect("blocking waiter released")
            .expect("join"),
        Err(GateError::Reconnecting)
    );

    // A control command issued during the outage is preserved.
    sender
        .send(AgentIoCommand::UnregisterSession {
            session_id: "s".to_string(),
        })
        .await
        .expect("control during outage");

    // Reconnected: drain + filter the backlog, re-queue survivors ungated.
    let kept = lanes.drain_reconnect_backlog();
    let kept_labels: Vec<String> = kept.iter().map(label).collect();
    assert_eq!(
        kept_labels,
        vec![
            "fwd:a",
            "fwd:b",
            "fwd-close:st",
            "unregister:s",
            "resize:80x24"
        ],
        "input dropped, forward bytes/close and control kept in order, resize coalesced last"
    );
    assert_eq!(
        budget.in_use(),
        data_cost(&fwd("a")) + data_cost(&fwd("b")),
        "dropped input returned its credit; survivors still hold theirs"
    );
    for cmd in kept {
        tx.send(cmd).expect("re-queue never waits on the budget");
    }
    reconnecting.store(false, Ordering::SeqCst);

    // The resumed loop: control first, then data in order.
    let mut served = Vec::new();
    for _ in 0..5 {
        match lanes.next_command().await {
            Next::Control(c) => served.push(label(&c)),
            Next::Data(c, credit) => {
                served.push(label(&c));
                drop(credit);
            }
            Next::Closed => panic!("sender alive"),
        }
    }
    assert_eq!(
        served,
        vec![
            "unregister:s",
            "fwd:a",
            "fwd:b",
            "fwd-close:st",
            "resize:80x24"
        ]
    );
    assert_eq!(budget.in_use(), 0, "no credit leaked across the reconnect");

    // And input flows normally again.
    sender
        .send(numbered_input(4))
        .await
        .expect("post-reconnect input");
}

// ── Budget fairness and edge cases ───────────────────────────────────

/// Credit is granted FIFO: a large write at the head of the line is not
/// starved by later small writes that would fit sooner.
#[tokio::test(start_paused = true)]
async fn credit_is_granted_in_arrival_order() {
    let budget = IoBudget::new(1000);
    let flag = AtomicBool::new(false);
    budget.acquire(600, &flag).await.expect("fits");

    let big = {
        let budget = budget.clone();
        tokio::spawn(async move { budget.acquire(900, &AtomicBool::new(false)).await })
    };
    tokio::task::yield_now().await;
    let small = {
        let budget = budget.clone();
        tokio::spawn(async move { budget.acquire(200, &AtomicBool::new(false)).await })
    };
    tokio::task::yield_now().await;
    assert!(!big.is_finished());
    assert!(
        !small.is_finished(),
        "a later small write must queue behind the waiting large one"
    );

    budget.release(600);
    big.await.expect("join").expect("head admitted first");
    tokio::task::yield_now().await;
    assert!(!small.is_finished(), "still no room behind the large write");
    budget.release(900);
    small.await.expect("join").expect("then the next");
}

/// A cancelled waiter gives up its place, so the line keeps moving.
#[tokio::test(start_paused = true)]
async fn cancelled_waiter_leaves_the_line() {
    let budget = IoBudget::new(100);
    let flag = AtomicBool::new(false);
    budget.acquire(100, &flag).await.expect("fits");
    let first = {
        let budget = budget.clone();
        tokio::spawn(async move { budget.acquire(50, &AtomicBool::new(false)).await })
    };
    tokio::task::yield_now().await;
    let second = {
        let budget = budget.clone();
        tokio::spawn(async move { budget.acquire(50, &AtomicBool::new(false)).await })
    };
    tokio::task::yield_now().await;
    assert_eq!(budget.waiters(), 2);
    first.abort();
    let _ = first.await;
    assert_eq!(budget.waiters(), 1);
    budget.release(100);
    second.await.expect("join").expect("admitted");
}

/// An item larger than the whole budget is admitted alone rather than never.
#[tokio::test]
async fn oversize_item_is_admitted_alone() {
    let budget = IoBudget::new(100);
    let flag = AtomicBool::new(false);
    budget
        .acquire(10_000, &flag)
        .await
        .expect("clamped to capacity");
    assert_eq!(budget.in_use(), 100);
    budget.release(10_000);
    assert_eq!(budget.in_use(), 0);
}

/// A synchronous producer on a current-thread runtime cannot block (it would
/// stall the executor that drains the queue): it fails instead of deadlocking,
/// but still succeeds whenever credit is free.
#[tokio::test]
async fn blocking_send_on_current_thread_refuses_to_deadlock() {
    let (sender, _lanes, budget, _reconnecting) = pipe(numbered_cost());
    sender
        .send_blocking(numbered_input(0))
        .expect("room: no wait needed");
    assert_eq!(
        sender.send_blocking(numbered_input(1)),
        Err(GateError::WouldDeadlock)
    );
    assert_eq!(budget.waiters(), 0, "the refused waiter left the line");
    // Control never needs credit.
    sender
        .send_blocking(AgentIoCommand::Disconnect)
        .expect("control send");
}

// ── Manager producers ────────────────────────────────────────────────

fn dummy_abort_handle() -> tokio::task::AbortHandle {
    use std::sync::OnceLock;
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    let rt = RT.get_or_init(|| {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("build throwaway test runtime")
    });
    rt.spawn(std::future::pending::<()>()).abort_handle()
}

fn connection(
    command_tx: mpsc::UnboundedSender<AgentIoCommand>,
    reconnecting: Arc<AtomicBool>,
) -> AgentConnection {
    AgentConnection {
        command_tx,
        alive: Arc::new(AtomicBool::new(true)),
        reconnecting,
        io_task: dummy_abort_handle(),
        capabilities: AgentCapabilities {
            connection_types: vec![],
            max_sessions: 0,
            available_shells: vec![],
            available_serial_ports: vec![],
            docker_available: false,
            available_docker_images: vec![],
            monitoring_supported: false,
            tool_streaming: false,
            embedded_server_activity: false,
            session_processes: false,
            agent_version: String::new(),
        },
        ki_activity: crate::terminal::agent_ki_prompt::AgentPromptActivity::new(),
        client_id: String::new(),
        reattach_config: crate::terminal::agent_config_store::RetainedAgentConfig {
            config: crate::terminal::backend::RemoteAgentConfig::default(),
            settings: crate::connection::config::AgentSettings::default(),
        },
    }
}

/// A manager with one fake agent whose I/O budget is `capacity`; returns the
/// ingress receiver, the budget and the reconnecting flag.
fn manager_with_agent(
    capacity: usize,
) -> (
    Arc<AgentConnectionManager<tauri::test::MockRuntime>>,
    mpsc::UnboundedReceiver<AgentIoCommand>,
    Arc<IoBudget>,
    Arc<AtomicBool>,
) {
    let app = tauri::test::mock_app();
    let manager = Arc::new(AgentConnectionManager::new(app.handle().clone()));
    let (tx, rx) = mpsc::unbounded_channel::<AgentIoCommand>();
    let reconnecting = Arc::new(AtomicBool::new(false));
    let budget = IoBudget::new(capacity);
    let mut agents = manager.agents.lock().expect("agents lock");
    manager
        .io_budgets
        .lock()
        .expect("budgets lock")
        .insert("agent-1".to_string(), budget.clone());
    agents.insert("agent-1".to_string(), connection(tx, reconnecting.clone()));
    drop(agents);
    (manager, rx, budget, reconnecting)
}

/// A paste larger than one chunk is split into bounded chunks that arrive in
/// order and reassemble to the original bytes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn large_paste_is_chunked_in_order() {
    let (manager, mut rx, _budget, _reconnecting) = manager_with_agent(AGENT_IO_DATA_BUDGET);
    let paste: Vec<u8> = (0..(3 * AGENT_IO_MAX_CHUNK + 123))
        .map(|i| (i % 251) as u8)
        .collect();
    manager
        .send_session_input("agent-1", "sess", &paste)
        .expect("paste");

    let mut joined = Vec::new();
    let mut chunks = 0;
    while let Ok(cmd) = rx.try_recv() {
        match cmd {
            AgentIoCommand::SessionInput { session_id, data } => {
                assert_eq!(session_id, "sess");
                assert!(data.len() <= AGENT_IO_MAX_CHUNK);
                joined.extend_from_slice(&data);
                chunks += 1;
            }
            _ => panic!("only input expected"),
        }
    }
    assert_eq!(chunks, 4);
    assert_eq!(joined, paste, "chunks reassemble in order");
}

/// `send_session_input` backpressures on a full budget and resumes as the
/// consumer frees credit — a multi-megabyte paste through a 1-chunk-deep
/// queue arrives complete and in order, never holding more than the budget.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn send_session_input_backpressures_until_drained() {
    let capacity = AGENT_IO_MAX_CHUNK + 4 * AGENT_IO_ITEM_OVERHEAD;
    let (manager, mut rx, budget, _reconnecting) = manager_with_agent(capacity);
    let paste: Vec<u8> = (0..(40 * AGENT_IO_MAX_CHUNK))
        .map(|i| (i % 253) as u8)
        .collect();
    let expected = paste.clone();

    let writer = {
        let manager = manager.clone();
        tokio::task::spawn_blocking(move || manager.send_session_input("agent-1", "sess", &paste))
    };

    let mut joined = Vec::new();
    while joined.len() < expected.len() {
        let cmd = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("writer keeps producing as credit frees")
            .expect("ingress open");
        assert!(budget.in_use() <= capacity);
        let cost = data_cost(&cmd);
        if let AgentIoCommand::SessionInput { data, .. } = cmd {
            joined.extend_from_slice(&data);
        }
        budget.release(cost);
    }
    writer.await.expect("join").expect("paste delivered");
    assert_eq!(joined, expected);
}

/// A terminal write parked on a full budget returns promptly — input dropped,
/// per CONC-014 — when the transport starts reconnecting.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn waiting_input_is_dropped_when_reconnect_starts() {
    let (manager, mut rx, budget, reconnecting) = manager_with_agent(numbered_cost());
    manager
        .send_session_input("agent-1", "s", b"00000000")
        .expect("fits");
    let writer = {
        let manager = manager.clone();
        tokio::task::spawn_blocking(move || manager.send_session_input("agent-1", "s", b"00000001"))
    };
    while budget.waiters() < 1 {
        tokio::task::yield_now().await;
    }
    reconnecting.store(true, Ordering::SeqCst);
    budget.interrupt();
    tokio::time::timeout(Duration::from_secs(5), writer)
        .await
        .expect("writer released")
        .expect("join")
        .expect("dropped input reports success (fire-and-forget)");
    assert!(rx.try_recv().is_ok(), "the first write was queued");
    assert!(rx.try_recv().is_err(), "the waiting write was dropped");
}

/// `disconnect_agent` releases a terminal write parked on a full budget with
/// an error instead of leaving it blocked forever.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disconnect_releases_waiting_input() {
    let (manager, _rx, budget, _reconnecting) = manager_with_agent(numbered_cost());
    manager
        .send_session_input("agent-1", "s", b"00000000")
        .expect("fits");
    let writer = {
        let manager = manager.clone();
        tokio::task::spawn_blocking(move || manager.send_session_input("agent-1", "s", b"00000001"))
    };
    while budget.waiters() < 1 {
        tokio::task::yield_now().await;
    }
    manager.disconnect_agent("agent-1").expect("disconnect");
    let result = tokio::time::timeout(Duration::from_secs(5), writer)
        .await
        .expect("writer released")
        .expect("join");
    assert!(result.is_err(), "a write to a torn-down agent fails");
    assert!(budget.is_closed());
}

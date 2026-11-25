//! Nothing waits forever for a helper that does not answer, or for a consumer
//! that does not read (#6030): a hang here freezes the tab.

use std::time::Duration;

use super::*;
use crate::connection::{CursorShape, CursorUpdate, FrameUpdate};

fn cursor(x: u32, shape: Option<u8>) -> CursorUpdate {
    CursorUpdate {
        x,
        y: 0,
        visible: true,
        shape: shape.map(|tone| CursorShape {
            width: 1,
            height: 1,
            hotspot_x: 0,
            hotspot_y: 0,
            data: vec![tone; 4],
        }),
    }
}

/// A connected session over in-memory pipes.
struct Session {
    rdp: SidecarRdp,
    shared: Arc<SidecarShared>,
    /// What the helper reads and writes.
    stdin: tokio::io::DuplexStream,
    stdout: tokio::io::DuplexStream,
    cancel: CancellationToken,
}

fn session() -> Session {
    // A pipe that holds little, so an unread one is full soon.
    let (host_write, stdin) = tokio::io::duplex(64);
    let (stdout, host_read) = tokio::io::duplex(64 * 1024);
    let (frame_tx, frame_rx) = mpsc::channel(CHANNEL_DEPTH);
    let (cursor_tx, cursor_rx) = mpsc::channel(CHANNEL_DEPTH);
    let (cert_tx, cert_rx) = mpsc::channel(CHANNEL_DEPTH);
    let (to_sidecar, sidecar_rx) = mpsc::channel(CHANNEL_DEPTH);
    let shared = Arc::new(SidecarShared::new(false, None));
    let cancel = CancellationToken::new();
    let tasks = vec![
        tokio::spawn(run_reader(
            host_read,
            frame_tx,
            cursor_tx,
            cert_tx,
            shared.clone(),
            cancel.clone(),
        )),
        tokio::spawn(run_writer(host_write, sidecar_rx, cancel.clone())),
    ];
    Session {
        rdp: SidecarRdp {
            runtime: Some(Arc::new(SidecarRuntime {
                to_sidecar,
                shared: shared.clone(),
                next_fetch_id: AtomicU64::new(1),
                cancel: cancel.clone(),
                _tunnel: None,
            })),
            frame_rx: StdMutex::new(Some(frame_rx)),
            cursor_rx: StdMutex::new(Some(cursor_rx)),
            cert_prompt_rx: StdMutex::new(Some(cert_rx)),
            tasks,
        },
        shared,
        stdin,
        stdout,
        cancel,
    }
}

/// Fill the queue to a helper that does not read.
fn fill_queue(session: &Session) {
    let queue = &session.rdp.runtime.as_ref().expect("runtime").to_sidecar;
    while queue
        .try_send(HostMessage::SetClipboard("x".repeat(200)))
        .is_ok()
    {}
}

/// `what` ends by itself, in (virtual) time.
async fn ends<T>(what: &str, future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(300), future)
        .await
        .unwrap_or_else(|_| panic!("{what} waits forever"))
}

/// Nobody takes the cursor updates: frames and the clipboard still arrive.
#[tokio::test(start_paused = true)]
async fn unread_cursor_updates_do_not_hold_up_the_session() {
    let mut session = session();
    let mut frames = session.rdp.subscribe_frames();
    for x in 0..4 * CHANNEL_DEPTH as u32 {
        let message = SidecarMessage::Cursor(cursor(x, (x == 1).then_some(7)));
        ends("the cursor", write_message(&mut session.stdout, &message))
            .await
            .expect("written");
    }
    let frame = FrameUpdate {
        width: 2,
        height: 1,
        rects: Vec::new(),
    };
    for message in [
        SidecarMessage::Clipboard("copied".to_string()),
        SidecarMessage::Frame(frame.clone()),
    ] {
        ends("the pipe", write_message(&mut session.stdout, &message))
            .await
            .expect("written");
    }
    assert_eq!(ends("the frame", frames.recv()).await, Some(frame));
    assert_eq!(session.rdp.get_clipboard().await.as_deref(), Some("copied"));

    // A late reader gets where the cursor is, and its last shape.
    let mut cursors = session.rdp.subscribe_cursor();
    let (mut last, mut shape) = (None, None);
    while let Ok(Some(update)) = tokio::time::timeout(Duration::from_secs(1), cursors.recv()).await
    {
        shape = update.shape.clone().or(shape);
        last = Some(update.x);
    }
    assert_eq!(last, Some(4 * CHANNEL_DEPTH as u32 - 1));
    assert_eq!(shape.map(|s| s.data), Some(vec![7; 4]));
}

/// A shape that waits behind a full channel is kept when a move replaces it.
#[tokio::test(start_paused = true)]
async fn a_cursor_shape_survives_the_moves_after_it() {
    let mut session = session();
    let shapes = CHANNEL_DEPTH as u32 + 10;
    for x in 0..shapes + 5 {
        let shape = (x == shapes).then_some(9);
        write_message(
            &mut session.stdout,
            &SidecarMessage::Cursor(cursor(x, shape)),
        )
        .await
        .expect("written");
    }
    let mut cursors = session.rdp.subscribe_cursor();
    let mut shape = None;
    while let Ok(Some(update)) = tokio::time::timeout(Duration::from_secs(1), cursors.recv()).await
    {
        shape = update.shape.or(shape);
    }
    assert_eq!(shape.map(|s| s.data), Some(vec![9; 4]));
}

#[tokio::test(start_paused = true)]
async fn the_reader_ends_with_the_session_when_nobody_takes_frames() {
    let mut session = session();
    let frame = SidecarMessage::Frame(FrameUpdate {
        width: 1,
        height: 1,
        rects: Vec::new(),
    });
    for _ in 0..2 * CHANNEL_DEPTH {
        write_message(&mut session.stdout, &frame)
            .await
            .expect("written");
    }
    tokio::time::sleep(Duration::from_secs(1)).await;
    let reader = session.rdp.tasks.remove(0);
    session.cancel.cancel();
    ends("the reader", reader).await.expect("reader");
}

#[tokio::test(start_paused = true)]
async fn disconnect_does_not_wait_for_a_helper_that_does_not_read() {
    let mut session = session();
    fill_queue(&session);
    tokio::time::sleep(Duration::from_millis(1)).await;
    fill_queue(&session);

    let began = tokio::time::Instant::now();
    ends("disconnect", session.rdp.disconnect())
        .await
        .expect("disconnect");

    assert!(
        began.elapsed() <= Duration::from_secs(3),
        "closing a tab took {:?}",
        began.elapsed()
    );
    assert!(session.cancel.is_cancelled());
    assert!(!session.rdp.is_connected());
    drop(session.stdin);
}

#[tokio::test(start_paused = true)]
async fn requests_to_a_helper_that_does_not_read_fail() {
    let session = session();
    fill_queue(&session);
    tokio::time::sleep(Duration::from_millis(1)).await;
    fill_queue(&session);
    let rdp = &session.rdp;
    let monitor = |x: i32, primary| MonitorRect {
        x,
        y: 0,
        width: 1024,
        height: 768,
        primary,
        scale: 100,
    };
    let layout = MonitorLayout::normalize(&[monitor(0, true), monitor(1024, false)]);
    let image = ClipboardImage::new(1, 1, vec![0; 4]).expect("image");
    let input = InputEvent::Pointer {
        x: 1,
        y: 1,
        buttons: 0,
    };
    let results = [
        ("input", ends("input", rdp.send_input(input)).await),
        (
            "resize",
            ends("resize", GraphicalBackend::resize(rdp, 800, 600)).await,
        ),
        (
            "layout",
            ends("layout", rdp.set_monitor_layout(layout.expect("layout"))).await,
        ),
        (
            "clipboard",
            ends("clipboard", rdp.set_clipboard("text".to_string())).await,
        ),
        ("image", ends("image", rdp.set_clipboard_image(image)).await),
        (
            "certificate",
            ends("certificate", rdp.send_cert_decision(true, false)).await,
        ),
    ];
    for (what, result) in results {
        let message = result.expect_err(what).to_string();
        assert!(message.contains("not respond"), "{what}: {message}");
    }
}

/// An ended session is no error for what only updates it.
#[tokio::test(start_paused = true)]
async fn updates_of_an_ended_session_are_ignored() {
    let session = session();
    session.cancel.cancel();
    tokio::time::sleep(Duration::from_secs(1)).await;
    let rdp = &session.rdp;
    GraphicalBackend::resize(rdp, 800, 600)
        .await
        .expect("resize");
    rdp.set_clipboard("text".to_string())
        .await
        .expect("clipboard");
    let input = InputEvent::Pointer {
        x: 1,
        y: 1,
        buttons: 0,
    };
    assert!(matches!(
        rdp.send_input(input).await,
        Err(SessionError::NotRunning(_))
    ));
}

/// The server never answers a paste of a file it offered.
#[tokio::test(start_paused = true)]
async fn a_file_fetch_that_gets_no_answer_fails() {
    let mut session = session();
    *session.shared.remote_clipboard_files.lock().await = vec![RemoteClipboardFile {
        name: "silent.txt".to_string(),
        relative_path: None,
        size: Some(5),
        is_dir: false,
        index: 0,
    }];
    let helper = tokio::spawn(async move {
        read_message::<_, HostMessage>(&mut session.stdin)
            .await
            .expect("request");
        // Alive, and silent.
        tokio::time::sleep(Duration::from_secs(3600)).await;
    });

    let result = ends("the fetch", session.rdp.fetch_remote_clipboard_file(0)).await;

    let message = result.expect_err("no file").to_string();
    assert!(message.contains("silent.txt"), "{message}");
    assert!(session.shared.fetches.lock().expect("fetches").is_empty());
    helper.abort();
}

/// A helper that never reads its connect request.
#[tokio::test(start_paused = true)]
async fn a_connect_request_that_is_not_read_fails() {
    let (mut host_write, _stdin) = tokio::io::duplex(16);
    let config = RdpConfig::from_settings(serde_json::json!({ "host": "server" })).expect("config");
    let result = ends("the request", send_connect(&mut host_write, config)).await;
    let message = result.expect_err("not sent").to_string();
    assert!(message.contains("not respond"), "{message}");
}

//! Mock graphical remote-desktop backend — a protocol-less test pattern.
//!
//! This backend implements both [`ConnectionType`] (as a terminal-less,
//! graphical connection) and [`GraphicalBackend`] so the shared remote-desktop
//! layer (#1680) **merges and is end-to-end testable with no real VNC/RDP
//! server**. It generates a moving test-pattern frame stream plus a synthetic
//! cursor, echoes the clipboard, and honours resize and view-only — exercising
//! every path of the shared canvas / toolbar / overlay / input pipeline.
//!
//! It is the graphical analogue of a loopback: real protocol backends (VNC
//! #1681, RDP #1682) drop in beside it under the same trait with no change to
//! this layer.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use serde::Deserialize;
use tokio::sync::mpsc;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::connection::{
    AuthKind, Capabilities, ConnectionType, CursorReceiver, CursorUpdate, DirtyRect, FrameReceiver,
    FrameUpdate, GraphicalBackend, GraphicalCapabilities, InputEvent, OutputReceiver,
    SettingsSchema,
};
use crate::errors::SessionError;
use crate::files::FileBrowser;
use crate::monitoring::MonitoringProvider;

/// Default mock framebuffer width, kept small to bound event payloads in tests.
const DEFAULT_WIDTH: u16 = 320;
/// Default mock framebuffer height.
const DEFAULT_HEIGHT: u16 = 240;
/// Upper bound on either dimension — mirrors the concept's framebuffer cap.
const MAX_DIMENSION: u16 = 1920;
/// Side length of the moving test-pattern block, in pixels.
const BLOCK: u32 = 48;
/// Frame-generation tick interval.
const TICK: std::time::Duration = std::time::Duration::from_millis(150);
/// Bounded channel depth for frames / cursor updates (backpressure).
const CHANNEL_DEPTH: usize = 16;

/// User-supplied mock settings (a subset of the shared field base plus test knobs).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MockConfig {
    /// Ignored by the mock (no real connection) — accepted for editor parity.
    #[serde(default)]
    #[allow(dead_code)]
    host: String,
    /// When true, input is suppressed and the view-only badge shows.
    #[serde(default)]
    view_only: bool,
    /// Optional initial framebuffer width override.
    #[serde(default)]
    width: Option<u16>,
    /// Optional initial framebuffer height override.
    #[serde(default)]
    height: Option<u16>,
}

/// Shared, interior-mutable state of a connected mock session.
struct MockRuntime {
    frame_tx: mpsc::Sender<FrameUpdate>,
    cursor_tx: mpsc::Sender<CursorUpdate>,
    clipboard: Mutex<String>,
    view_only: bool,
    dims: Mutex<(u16, u16)>,
    /// Count of accepted input events — lets tests assert view-only suppression.
    input_count: AtomicU64,
    cancel: CancellationToken,
}

/// Mock graphical remote-desktop connection.
pub struct MockRemoteDesktop {
    runtime: Option<Arc<MockRuntime>>,
    frame_rx: StdMutex<Option<FrameReceiver>>,
    cursor_rx: StdMutex<Option<CursorReceiver>>,
    task: Option<JoinHandle<()>>,
}

impl MockRemoteDesktop {
    /// Create a new, disconnected mock backend.
    pub fn new() -> Self {
        Self {
            runtime: None,
            frame_rx: StdMutex::new(None),
            cursor_rx: StdMutex::new(None),
            task: None,
        }
    }

    /// Test-only accessor: how many input events the session has accepted
    /// (0 while view-only). Returns `None` when disconnected.
    #[doc(hidden)]
    pub fn accepted_input_count(&self) -> Option<u64> {
        self.runtime
            .as_ref()
            .map(|rt| rt.input_count.load(Ordering::SeqCst))
    }
}

impl Default for MockRemoteDesktop {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for MockRemoteDesktop {
    fn drop(&mut self) {
        if let Some(rt) = &self.runtime {
            rt.cancel.cancel();
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// Clamp a requested dimension into `1..=MAX_DIMENSION`, defaulting when zero.
fn clamp_dim(value: u16, default: u16) -> u16 {
    match value {
        0 => default,
        v => v.min(MAX_DIMENSION),
    }
}

/// Build a full-framebuffer background frame: a dark checkerboard so the surface
/// visibly reads as a live remote desktop rather than a blank canvas.
fn background_frame(width: u16, height: u16) -> FrameUpdate {
    let (w, h) = (width as u32, height as u32);
    let mut data = vec![0u8; (w * h * 4) as usize];
    for y in 0..h {
        for x in 0..w {
            let idx = ((y * w + x) * 4) as usize;
            let checker = ((x / 24) + (y / 24)) % 2 == 0;
            let base = if checker { 18 } else { 30 };
            data[idx] = base; // R
            data[idx + 1] = base + 4; // G
            data[idx + 2] = base + 10; // B
            data[idx + 3] = 255; // A
        }
    }
    FrameUpdate {
        width: w,
        height: h,
        rects: vec![DirtyRect {
            x: 0,
            y: 0,
            width: w,
            height: h,
            data,
        }],
    }
}

/// Build the moving-block dirty rect for tick `i`, bouncing within the frame.
fn moving_block(width: u16, height: u16, i: u32) -> DirtyRect {
    let (w, h) = (width as u32, height as u32);
    let span_x = w.saturating_sub(BLOCK).max(1);
    let span_y = h.saturating_sub(BLOCK).max(1);
    // Triangle-wave bounce so the block stays inside the framebuffer.
    let bx = triangle(i * 7, span_x);
    let by = triangle(i * 5, span_y);
    let bw = BLOCK.min(w);
    let bh = BLOCK.min(h);
    let mut data = vec![0u8; (bw * bh * 4) as usize];
    // A bright accent block whose hue cycles with the tick.
    let r = (80 + (i * 9) % 160) as u8;
    let g = (120 + (i * 5) % 120) as u8;
    let b = 220u8;
    for px in data.as_chunks_mut::<4>().0 {
        px[0] = r;
        px[1] = g;
        px[2] = b;
        px[3] = 255;
    }
    DirtyRect {
        x: bx,
        y: by,
        width: bw,
        height: bh,
        data,
    }
}

/// Triangle wave in `0..=span` from a monotonically-increasing input.
fn triangle(t: u32, span: u32) -> u32 {
    if span == 0 {
        return 0;
    }
    let period = span * 2;
    let phase = t % period;
    if phase <= span {
        phase
    } else {
        period - phase
    }
}

/// Background frame-generation loop: emits the moving block and synthetic cursor
/// each tick until the session is cancelled.
async fn generate(rt: Arc<MockRuntime>) {
    // Paint the initial full background so the canvas is never blank.
    let (w0, h0) = *rt.dims.lock().await;
    let _ = rt.frame_tx.send(background_frame(w0, h0)).await;

    let mut ticker = tokio::time::interval(TICK);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut i: u32 = 0;
    loop {
        tokio::select! {
            _ = rt.cancel.cancelled() => break,
            _ = ticker.tick() => {
                let (w, h) = *rt.dims.lock().await;
                let block = moving_block(w, h, i);
                let (cx, cy) = (block.x + block.width / 2, block.y + block.height / 2);
                let frame = FrameUpdate {
                    width: w as u32,
                    height: h as u32,
                    rects: vec![block],
                };
                // Drop rather than block if the consumer is slow — a mock never
                // stalls the runtime.
                let _ = rt.frame_tx.try_send(frame);
                let _ = rt.cursor_tx.try_send(CursorUpdate {
                    x: cx,
                    y: cy,
                    visible: true,
                    shape: None,
                });
                i = i.wrapping_add(1);
            }
        }
    }
}

#[async_trait::async_trait]
impl ConnectionType for MockRemoteDesktop {
    fn type_id(&self) -> &str {
        "mock-remote-desktop"
    }

    fn display_name(&self) -> &str {
        "Mock Remote Desktop"
    }

    fn settings_schema(&self) -> SettingsSchema {
        // The mock renders the shared field base only — it is the reference for
        // the seam a real protocol backend layers its extra group onto.
        SettingsSchema {
            groups: crate::connection::shared_field_base(5900),
        }
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: false,
            // Graphical + terminal-less: the desktop routes this through the
            // GraphicalSessionManager into a remote-desktop canvas tab.
            graphical: true,
            resize: false,
            persistent: false,
            terminal: false,
        }
    }

    async fn connect(&mut self, settings: serde_json::Value) -> Result<(), SessionError> {
        if self.runtime.is_some() {
            return Err(SessionError::AlreadyExists("Already connected".to_string()));
        }
        let cfg: MockConfig = serde_json::from_value(settings)
            .map_err(|e| SessionError::InvalidConfig(format!("Invalid mock settings: {e}")))?;

        let width = clamp_dim(cfg.width.unwrap_or(DEFAULT_WIDTH), DEFAULT_WIDTH);
        let height = clamp_dim(cfg.height.unwrap_or(DEFAULT_HEIGHT), DEFAULT_HEIGHT);

        let (frame_tx, frame_rx) = mpsc::channel(CHANNEL_DEPTH);
        let (cursor_tx, cursor_rx) = mpsc::channel(CHANNEL_DEPTH);
        let runtime = Arc::new(MockRuntime {
            frame_tx,
            cursor_tx,
            clipboard: Mutex::new(String::new()),
            view_only: cfg.view_only,
            dims: Mutex::new((width, height)),
            input_count: AtomicU64::new(0),
            cancel: CancellationToken::new(),
        });

        let task = tokio::spawn(generate(runtime.clone()));

        self.frame_rx = StdMutex::new(Some(frame_rx));
        self.cursor_rx = StdMutex::new(Some(cursor_rx));
        self.runtime = Some(runtime);
        self.task = Some(task);
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<(), SessionError> {
        if let Some(rt) = self.runtime.take() {
            rt.cancel.cancel();
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
        self.frame_rx = StdMutex::new(None);
        self.cursor_rx = StdMutex::new(None);
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.runtime.is_some()
    }

    fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
        // Graphical session: no terminal byte stream.
        Ok(())
    }

    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        // Terminal (cols/rows) resize is meaningless; pixel resize is on the
        // GraphicalBackend trait.
        Ok(())
    }

    fn subscribe_output(&self) -> OutputReceiver {
        let (_tx, rx) = mpsc::channel(1);
        rx
    }

    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }

    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }

    fn graphical(&self) -> Option<&dyn GraphicalBackend> {
        if self.runtime.is_some() {
            Some(self as &dyn GraphicalBackend)
        } else {
            None
        }
    }
}

#[async_trait::async_trait]
impl GraphicalBackend for MockRemoteDesktop {
    fn graphical_capabilities(&self) -> GraphicalCapabilities {
        GraphicalCapabilities {
            auth_kinds: vec![AuthKind::None, AuthKind::Password],
            supports_dynamic_resize: true,
            supports_clipboard: true,
            view_only_capable: true,
        }
    }

    fn subscribe_frames(&self) -> FrameReceiver {
        if let Ok(mut guard) = self.frame_rx.lock() {
            if let Some(rx) = guard.take() {
                return rx;
            }
        }
        let (_tx, rx) = mpsc::channel(1);
        rx
    }

    fn subscribe_cursor(&self) -> CursorReceiver {
        if let Ok(mut guard) = self.cursor_rx.lock() {
            if let Some(rx) = guard.take() {
                return rx;
            }
        }
        let (_tx, rx) = mpsc::channel(1);
        rx
    }

    async fn send_input(&self, event: InputEvent) -> Result<(), SessionError> {
        let Some(rt) = &self.runtime else {
            return Err(SessionError::NotRunning("mock not connected".to_string()));
        };
        if rt.view_only {
            // View-only: silently drop input (do not count it).
            return Ok(());
        }
        rt.input_count.fetch_add(1, Ordering::SeqCst);
        // Echo pointer movement back as a synthetic cursor update so the
        // frontend's input round-trip is observable end-to-end.
        if let InputEvent::Pointer { x, y, .. } = event {
            let _ = rt.cursor_tx.try_send(CursorUpdate {
                x,
                y,
                visible: true,
                shape: None,
            });
        }
        Ok(())
    }

    async fn resize(&self, width_px: u16, height_px: u16) -> Result<(), SessionError> {
        let Some(rt) = &self.runtime else {
            return Err(SessionError::NotRunning("mock not connected".to_string()));
        };
        let w = clamp_dim(width_px, DEFAULT_WIDTH);
        let h = clamp_dim(height_px, DEFAULT_HEIGHT);
        *rt.dims.lock().await = (w, h);
        // Repaint the whole surface at the new resolution.
        let _ = rt.frame_tx.send(background_frame(w, h)).await;
        Ok(())
    }

    async fn request_full_frame(&self) -> Result<(), SessionError> {
        let Some(rt) = &self.runtime else {
            return Err(SessionError::NotRunning("mock not connected".to_string()));
        };
        // A cross-window (re)attach (#1904): re-send the whole framebuffer so the
        // destination canvas repaints promptly instead of waiting for the next
        // moving-block tick.
        let (w, h) = *rt.dims.lock().await;
        let _ = rt.frame_tx.send(background_frame(w, h)).await;
        Ok(())
    }

    async fn get_clipboard(&self) -> Option<String> {
        let rt = self.runtime.as_ref()?;
        let text = rt.clipboard.lock().await.clone();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }

    async fn set_clipboard(&self, text: String) -> Result<(), SessionError> {
        let Some(rt) = &self.runtime else {
            return Err(SessionError::NotRunning("mock not connected".to_string()));
        };
        *rt.clipboard.lock().await = text;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn connected() -> MockRemoteDesktop {
        MockRemoteDesktop::new()
    }

    #[test]
    fn metadata_and_capabilities() {
        let m = connected();
        assert_eq!(m.type_id(), "mock-remote-desktop");
        let caps = m.capabilities();
        assert!(caps.graphical);
        assert!(!caps.terminal);
        assert!(!caps.file_browser);
    }

    #[test]
    fn graphical_none_until_connected() {
        assert!(connected().graphical().is_none());
    }

    #[test]
    fn schema_is_shared_field_base() {
        let schema = connected().settings_schema();
        let keys: Vec<&str> = schema.groups.iter().map(|g| g.key.as_str()).collect();
        assert_eq!(keys, vec!["connection", "display", "features"]);
    }

    #[test]
    fn triangle_stays_in_range() {
        for span in [0u32, 1, 48, 300] {
            for t in 0..1000 {
                assert!(triangle(t, span) <= span);
            }
        }
    }

    #[test]
    fn background_frame_is_well_formed() {
        let f = background_frame(64, 48);
        assert_eq!(f.width, 64);
        assert_eq!(f.height, 48);
        assert!(f.rects[0].is_well_formed());
    }

    #[test]
    fn moving_block_stays_in_bounds_and_well_formed() {
        for i in 0..500 {
            let r = moving_block(320, 240, i);
            assert!(r.is_well_formed());
            assert!(r.x + r.width <= 320);
            assert!(r.y + r.height <= 240);
        }
    }

    #[tokio::test]
    async fn connect_then_frames_flow() {
        let mut m = connected();
        m.connect(serde_json::json!({ "host": "x" })).await.unwrap();
        assert!(m.is_connected());
        assert!(m.graphical().is_some());
        let mut frames = m.subscribe_frames();
        // First frame is the full background, arriving promptly.
        let first = tokio::time::timeout(Duration::from_secs(2), frames.recv())
            .await
            .expect("a frame should arrive")
            .expect("channel open");
        assert!(!first.rects.is_empty());
        assert_eq!(first.width, DEFAULT_WIDTH as u32);
        m.disconnect().await.unwrap();
        assert!(!m.is_connected());
    }

    #[tokio::test]
    async fn resize_changes_frame_dimensions() {
        let mut m = connected();
        m.connect(serde_json::json!({})).await.unwrap();
        let mut frames = m.subscribe_frames();
        // Drain the initial background.
        let _ = tokio::time::timeout(Duration::from_secs(2), frames.recv())
            .await
            .unwrap();
        let backend = m.graphical().unwrap();
        backend.resize(640, 480).await.unwrap();
        // The resize repaint carries the new dimensions.
        loop {
            let f = tokio::time::timeout(Duration::from_secs(2), frames.recv())
                .await
                .expect("frame")
                .expect("open");
            if f.width == 640 {
                assert_eq!(f.height, 480);
                break;
            }
        }
        m.disconnect().await.unwrap();
    }

    #[tokio::test]
    async fn request_full_frame_re_emits_background() {
        let mut m = connected();
        m.connect(serde_json::json!({})).await.unwrap();
        let mut frames = m.subscribe_frames();
        // Drain the initial background.
        let _ = tokio::time::timeout(Duration::from_secs(2), frames.recv())
            .await
            .unwrap();
        let backend = m.graphical().unwrap();
        backend.request_full_frame().await.unwrap();
        // A full-surface frame follows: a single rect covering the whole
        // framebuffer (moving-block ticks only paint a small dirty rect).
        loop {
            let f = tokio::time::timeout(Duration::from_secs(2), frames.recv())
                .await
                .expect("frame")
                .expect("open");
            let full = f
                .rects
                .iter()
                .any(|r| r.x == 0 && r.y == 0 && r.width == f.width && r.height == f.height);
            if full {
                assert_eq!(f.width, DEFAULT_WIDTH as u32);
                break;
            }
        }
        m.disconnect().await.unwrap();
    }

    #[tokio::test]
    async fn clipboard_round_trips() {
        let mut m = connected();
        m.connect(serde_json::json!({})).await.unwrap();
        let backend = m.graphical().unwrap();
        assert!(backend.get_clipboard().await.is_none());
        backend.set_clipboard("hello".to_string()).await.unwrap();
        assert_eq!(backend.get_clipboard().await.as_deref(), Some("hello"));
        m.disconnect().await.unwrap();
    }

    #[tokio::test]
    async fn view_only_suppresses_input() {
        let mut m = connected();
        m.connect(serde_json::json!({ "viewOnly": true }))
            .await
            .unwrap();
        m.graphical()
            .unwrap()
            .send_input(InputEvent::Pointer {
                x: 5,
                y: 6,
                buttons: 1,
            })
            .await
            .unwrap();
        assert_eq!(m.accepted_input_count(), Some(0));
        m.disconnect().await.unwrap();
    }

    #[tokio::test]
    async fn input_accepted_when_not_view_only() {
        let mut m = connected();
        m.connect(serde_json::json!({})).await.unwrap();
        m.graphical()
            .unwrap()
            .send_input(InputEvent::Key {
                code: "KeyA".to_string(),
                pressed: true,
            })
            .await
            .unwrap();
        assert_eq!(m.accepted_input_count(), Some(1));
        m.disconnect().await.unwrap();
    }
}

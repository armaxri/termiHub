//! Protocol-agnostic graphical remote-desktop abstraction.
//!
//! This is the framebuffer-oriented sibling of the byte-stream
//! [`ConnectionType`](super::ConnectionType) trait. Where a terminal connection
//! exposes `write(&[u8])` / `subscribe_output() -> bytes`, a graphical
//! connection exposes a stream of **protocol-agnostic** frame and cursor
//! updates, a protocol-agnostic input channel, pixel-based resize, and text
//! clipboard access.
//!
//! Decode happens in the backend (Rust): VNC (RFB) and RDP (IronRDP) backends
//! both decode on the wire and emit the *same* [`FrameUpdate`] / [`CursorUpdate`]
//! events, so the entire user-facing frontend (canvas, toolbar, overlays, input
//! capture, clipboard, resize) is protocol-blind and shared. The seam between
//! "same for the user" and "different on the wire" is drawn exactly at the
//! [`GraphicalBackend`] trait boundary.
//!
//! A graphical connection type reports [`Capabilities::graphical`](super::Capabilities::graphical)
//! `= true` and [`Capabilities::terminal`](super::Capabilities::terminal) `= false`,
//! flows through the *same* [`ConnectionTypeRegistry`](super::ConnectionTypeRegistry),
//! connection editor, sidebar, and credential store as every other type, and
//! exposes its framebuffer surface via
//! [`ConnectionType::graphical()`](super::ConnectionType::graphical) — exactly
//! the way FTP exposes a file browser via `file_browser()`.

use super::schema::{FieldType, SelectOption, SettingsField, SettingsGroup};
use crate::errors::SessionError;
use serde::{Deserialize, Serialize};

/// Build a [`SettingsField`] with all optional metadata cleared; callers
/// override the fields they care about via struct-update syntax.
fn field(key: &str, label: &str, field_type: FieldType) -> SettingsField {
    SettingsField {
        key: key.to_string(),
        label: label.to_string(),
        description: None,
        help_text: None,
        field_type,
        required: false,
        default: None,
        placeholder: None,
        supports_env_expansion: false,
        supports_tilde_expansion: false,
        visible_when: None,
    }
}

/// Convenience constructor for a [`SelectOption`].
fn opt(value: &str, label: &str) -> SelectOption {
    SelectOption {
        value: value.to_string(),
        label: label.to_string(),
    }
}

/// The **shared field base** every graphical remote-desktop connection editor
/// renders, identically, through the existing `DynamicForm`.
///
/// This is the anti-collision seam on the schema side: a protocol backend
/// (VNC #1681, RDP #1682) builds its own [`super::SettingsSchema`] as
/// `shared_field_base()` **plus** its own extra group(s) — it never edits a
/// hand-written editor switch and never duplicates these rows. Returned as a
/// list of groups so a backend can append its protocol-specific group in the
/// natural position.
///
/// Groups: **Connection** (host, port, username, password + save-to-store),
/// **Display** (scale mode, color depth), **Features** (view only, clipboard
/// sync, auto-reconnect).
pub fn shared_field_base(default_port: u16) -> Vec<SettingsGroup> {
    vec![
        SettingsGroup {
            key: "connection".to_string(),
            label: "Connection".to_string(),
            fields: vec![
                SettingsField {
                    required: true,
                    supports_env_expansion: true,
                    placeholder: Some("host.example.com".to_string()),
                    ..field("host", "Host", FieldType::Text)
                },
                SettingsField {
                    required: true,
                    default: Some(serde_json::json!(default_port)),
                    ..field("port", "Port", FieldType::Port)
                },
                SettingsField {
                    supports_env_expansion: true,
                    ..field("username", "Username", FieldType::Text)
                },
                SettingsField {
                    ..field("password", "Password", FieldType::Password)
                },
                SettingsField {
                    default: Some(serde_json::json!(false)),
                    description: Some(
                        "Save the password to the credential store for reuse".to_string(),
                    ),
                    ..field("saveToStore", "Save to store", FieldType::Boolean)
                },
            ],
        },
        SettingsGroup {
            key: "display".to_string(),
            label: "Display".to_string(),
            fields: vec![
                SettingsField {
                    default: Some(serde_json::json!("fit")),
                    description: Some("How the remote framebuffer fills the tab".to_string()),
                    ..field(
                        "scaleMode",
                        "Scale Mode",
                        FieldType::Select {
                            options: vec![
                                opt("fit", "Fit to Tab"),
                                opt("pixel", "1:1 Pixel"),
                                opt("match", "Match Window"),
                            ],
                        },
                    )
                },
                SettingsField {
                    default: Some(serde_json::json!("32")),
                    ..field(
                        "colorDepth",
                        "Color Depth",
                        FieldType::Select {
                            options: vec![
                                opt("32", "32-bit"),
                                opt("24", "24-bit"),
                                opt("16", "16-bit"),
                                opt("8", "8-bit"),
                            ],
                        },
                    )
                },
            ],
        },
        SettingsGroup {
            key: "features".to_string(),
            label: "Features".to_string(),
            fields: vec![
                SettingsField {
                    default: Some(serde_json::json!(false)),
                    description: Some(
                        "Observe only — suppress all keyboard/mouse input".to_string(),
                    ),
                    ..field("viewOnly", "View Only", FieldType::Boolean)
                },
                SettingsField {
                    default: Some(serde_json::json!(true)),
                    description: Some("Sync text clipboard both ways".to_string()),
                    ..field("clipboardSync", "Clipboard Sync", FieldType::Boolean)
                },
                SettingsField {
                    default: Some(serde_json::json!(true)),
                    description: Some(
                        "Automatically retry (up to 3 times) after an unexpected drop".to_string(),
                    ),
                    ..field("autoReconnect", "Auto-Reconnect", FieldType::Boolean)
                },
            ],
        },
    ]
}

/// Async receiver for decoded frame updates from a graphical backend.
pub type FrameReceiver = tokio::sync::mpsc::Receiver<FrameUpdate>;

/// Async receiver for cursor-shape / position updates from a graphical backend.
pub type CursorReceiver = tokio::sync::mpsc::Receiver<CursorUpdate>;

/// Async receiver for interactive server-certificate trust prompts (#1767).
pub type CertPromptReceiver = tokio::sync::mpsc::Receiver<CertPrompt>;

/// A server-certificate trust prompt raised by a graphical backend that reached
/// an untrusted certificate and needs an interactive accept/reject decision
/// (RDP, #1767). The `fingerprint` (SHA-256 of the server public key) is the
/// identity the host keys its persisted trust store on; `subject`/`issuer` are
/// best-effort human context for the dialog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CertPrompt {
    /// SHA-256 fingerprint of the server public key (`sha256:AB:CD:…`).
    pub fingerprint: String,
    /// Certificate subject, when the backend could extract it.
    pub subject: Option<String>,
    /// Certificate issuer, when the backend could extract it.
    pub issuer: Option<String>,
}

/// A single decoded, dirty rectangle of the remote framebuffer.
///
/// `data` is tightly-packed RGBA (`width * height * 4` bytes), row-major, in the
/// rectangle's own coordinate space. The frontend blits it into the shared
/// `<canvas>` at (`x`, `y`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyRect {
    /// X offset of the rectangle within the framebuffer, in pixels.
    pub x: u32,
    /// Y offset of the rectangle within the framebuffer, in pixels.
    pub y: u32,
    /// Rectangle width in pixels.
    pub width: u32,
    /// Rectangle height in pixels.
    pub height: u32,
    /// Tightly-packed RGBA pixel data (`width * height * 4` bytes).
    ///
    /// Serialized as a JSON array of bytes; the frontend reconstructs a
    /// `Uint8ClampedArray` / `ImageData` from it. Backends should keep rects
    /// small (dirty regions only) so the payload stays bounded.
    pub data: Vec<u8>,
}

impl DirtyRect {
    /// Whether `data`'s length matches `width * height * 4`.
    ///
    /// A malformed rect (wrong-sized buffer) must never be emitted; callers use
    /// this in debug assertions / tests.
    pub fn is_well_formed(&self) -> bool {
        self.data.len() as u64 == self.width as u64 * self.height as u64 * 4
    }
}

/// A protocol-agnostic framebuffer update: the current full dimensions plus the
/// list of dirty rectangles that changed since the previous update.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameUpdate {
    /// Full framebuffer width in pixels.
    pub width: u32,
    /// Full framebuffer height in pixels.
    pub height: u32,
    /// Dirty rectangles to blit. Empty is a valid no-op (e.g. a keep-alive).
    pub rects: Vec<DirtyRect>,
}

/// A protocol-agnostic cursor update.
///
/// Backends emit these when the remote pointer moves or its shape changes. When
/// `shape` is `None`, only the position/visibility changed and the frontend
/// keeps the current cursor image.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorUpdate {
    /// Cursor X position within the framebuffer, in pixels.
    pub x: u32,
    /// Cursor Y position within the framebuffer, in pixels.
    pub y: u32,
    /// Whether the remote cursor is visible.
    pub visible: bool,
    /// Optional new cursor shape. `None` = position/visibility change only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shape: Option<CursorShape>,
}

/// An RGBA cursor bitmap with its hotspot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorShape {
    /// Cursor image width in pixels.
    pub width: u32,
    /// Cursor image height in pixels.
    pub height: u32,
    /// Hotspot X within the image.
    pub hotspot_x: u32,
    /// Hotspot Y within the image.
    pub hotspot_y: u32,
    /// Tightly-packed RGBA pixel data (`width * height * 4` bytes).
    pub data: Vec<u8>,
}

/// A protocol-agnostic input event travelling from the frontend to the backend.
///
/// The backend encodes it to the wire protocol (RFB `KeyEvent`/`PointerEvent`
/// or an RDP input PDU). Pointer coordinates are already reverse-scaled to
/// framebuffer pixels by the shared frontend helper before they arrive here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InputEvent {
    /// A key press or release, keyed by a protocol-agnostic identifier
    /// (the browser `KeyboardEvent.code`, e.g. `"Enter"`, `"KeyA"`, `"ControlLeft"`).
    Key {
        /// Physical key identifier (`KeyboardEvent.code`).
        code: String,
        /// `true` for keydown, `false` for keyup.
        pressed: bool,
    },
    /// A pointer move / button change. `buttons` is a bitmask matching the DOM
    /// `MouseEvent.buttons` convention (bit 0 = left, bit 1 = right, bit 2 = middle).
    Pointer {
        /// X in framebuffer pixels.
        x: u32,
        /// Y in framebuffer pixels.
        y: u32,
        /// Pressed-button bitmask (DOM `MouseEvent.buttons` convention).
        buttons: u8,
    },
    /// A scroll-wheel event, in framebuffer pixels-ish deltas.
    Wheel {
        /// X in framebuffer pixels.
        x: u32,
        /// Y in framebuffer pixels.
        y: u32,
        /// Horizontal wheel delta.
        delta_x: f64,
        /// Vertical wheel delta.
        delta_y: f64,
    },
}

/// An authentication scheme a graphical backend can negotiate.
///
/// The shared connection editor is protocol-blind; a backend advertises what it
/// supports so the frontend can, e.g., show a security warning for insecure
/// schemes. Serialized lowercase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthKind {
    /// No authentication (open server).
    None,
    /// A single password (classic VNC / RFB).
    Password,
    /// Username + password (RDP, VeNCrypt).
    UsernamePassword,
    /// Network Level Authentication (RDP CredSSP).
    Nla,
}

/// Static descriptor of what a graphical backend supports.
///
/// Advertised by [`GraphicalBackend::graphical_capabilities`] so the shared
/// frontend can enable/disable toolbar affordances (clipboard button, view-only
/// badge) without knowing the protocol.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphicalCapabilities {
    /// Authentication schemes this backend can negotiate.
    pub auth_kinds: Vec<AuthKind>,
    /// Whether the backend can request a new session resolution at runtime
    /// (RDP Display Control Channel / VNC `SetDesktopSize`).
    pub supports_dynamic_resize: bool,
    /// Whether the backend syncs text clipboard both ways.
    pub supports_clipboard: bool,
    /// Whether the backend can run in view-only mode (input suppressed).
    pub view_only_capable: bool,
}

/// Metadata for one file the remote copied to its clipboard, surfaced to the
/// host so it can offer the file for a local paste and fetch the bytes on demand
/// — **delayed rendering** (#1793).
///
/// The [`index`](Self::index) is the file's position in the remote's advertised
/// file list; it is the opaque token the host passes back to
/// [`GraphicalBackend::fetch_remote_clipboard_file`] to pull the bytes. The
/// remote only ever selects an advertised index, never a path, so it can never
/// coax the host into fetching a file it did not copy. `name`/`relative_path`
/// are already sanitized by the backend before they are surfaced (no `..`,
/// absolute paths, drive letters, `:`/NUL, or reserved device names), but the
/// host re-validates them before they reach any local path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteClipboardFile {
    /// Sanitized basename (no path separators).
    pub name: String,
    /// Sanitized `/`-separated directory portion within the copied collection, or
    /// `None` for a top-level entry — lets the host rebuild a copied tree.
    pub relative_path: Option<String>,
    /// File size when the remote advertised it; `None` means "resolve on fetch".
    pub size: Option<u64>,
    /// Whether this entry is a directory (no bytes to fetch, offered only so the
    /// host can recreate the folder).
    pub is_dir: bool,
    /// Position in the remote's advertised file list — the fetch token.
    pub index: u32,
}

/// The shared graphical-session lifecycle state.
///
/// Identical for every protocol: the frontend renders overlays and the tab
/// state-dot purely from this. Serialized camelCase for the
/// `remote-desktop-state` event payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GraphicalState {
    /// Establishing the transport (TCP / TLS).
    Connecting,
    /// Transport up, negotiating authentication.
    Authenticating,
    /// Authenticated and painting frames.
    Active,
    /// A resize was requested; awaiting the new resolution.
    Resizing,
    /// The connection dropped unexpectedly; an auto-retry is pending.
    Disconnected,
    /// Actively retrying after an unexpected drop.
    Reconnecting,
    /// The server closed the session cleanly (logoff).
    ServerClosed,
    /// Authentication was rejected.
    AuthFailed,
    /// The transport failed to establish (network / TLS error).
    ConnectFailed,
    /// The session ended (user disconnect or dismissed error). Terminal state.
    Closed,
}

impl GraphicalState {
    /// Whether this is a terminal state (no further transitions).
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            GraphicalState::Closed | GraphicalState::ServerClosed | GraphicalState::ConnectFailed
        )
    }

    /// Whether a session in this state is live (painting or about to).
    pub fn is_live(self) -> bool {
        matches!(self, GraphicalState::Active | GraphicalState::Resizing)
    }
}

/// Maximum automatic reconnect attempts after an unexpected drop.
pub const MAX_RECONNECT_ATTEMPTS: u32 = 3;

/// Pure, protocol-agnostic driver of the shared session state machine.
///
/// Holds no I/O; it exists so the transition rules (and the max-3 auto-retry
/// cap) are unit-testable without a backend or Tauri. The
/// [`GraphicalSessionManager`](../../session) drives it in response to backend
/// and user events and emits `remote-desktop-state` on each change.
#[derive(Debug, Clone)]
pub struct SessionStateMachine {
    state: GraphicalState,
    reconnect_attempts: u32,
    max_reconnects: u32,
}

impl Default for SessionStateMachine {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionStateMachine {
    /// Create a machine in the initial `Connecting` state.
    pub fn new() -> Self {
        Self {
            state: GraphicalState::Connecting,
            reconnect_attempts: 0,
            max_reconnects: MAX_RECONNECT_ATTEMPTS,
        }
    }

    /// The current state.
    pub fn state(&self) -> GraphicalState {
        self.state
    }

    /// How many auto-reconnect attempts have been consumed since the last
    /// successful `Active`.
    pub fn reconnect_attempts(&self) -> u32 {
        self.reconnect_attempts
    }

    /// The transport came up; move `Connecting`/`Reconnecting` → `Authenticating`.
    pub fn transport_up(&mut self) -> GraphicalState {
        if matches!(
            self.state,
            GraphicalState::Connecting | GraphicalState::Reconnecting
        ) {
            self.state = GraphicalState::Authenticating;
        }
        self.state
    }

    /// Authentication succeeded and the first frame arrived; become `Active`.
    ///
    /// Resets the reconnect counter — a fresh live session starts the max-3
    /// budget over.
    pub fn activated(&mut self) -> GraphicalState {
        if matches!(
            self.state,
            GraphicalState::Authenticating
                | GraphicalState::Connecting
                | GraphicalState::Reconnecting
                | GraphicalState::Resizing
        ) {
            self.state = GraphicalState::Active;
            self.reconnect_attempts = 0;
        }
        self.state
    }

    /// A resize was requested while `Active`.
    pub fn resize_requested(&mut self) -> GraphicalState {
        if self.state == GraphicalState::Active {
            self.state = GraphicalState::Resizing;
        }
        self.state
    }

    /// The new resolution arrived; `Resizing` → `Active`.
    pub fn resize_complete(&mut self) -> GraphicalState {
        if self.state == GraphicalState::Resizing {
            self.state = GraphicalState::Active;
        }
        self.state
    }

    /// The connection dropped unexpectedly; move to `Disconnected` (auto-retry
    /// pending). Only meaningful from a live state.
    pub fn connection_dropped(&mut self) -> GraphicalState {
        if self.state.is_live() {
            self.state = GraphicalState::Disconnected;
        }
        self.state
    }

    /// Begin an auto-reconnect attempt.
    ///
    /// From `Disconnected`, if the attempt budget is not exhausted, increments
    /// the counter and moves to `Reconnecting`; once the cap is hit it stays
    /// `Disconnected` and returns it so the manager surfaces the manual
    /// reconnect prompt.
    pub fn begin_reconnect(&mut self) -> GraphicalState {
        if self.state == GraphicalState::Disconnected
            && self.reconnect_attempts < self.max_reconnects
        {
            self.reconnect_attempts += 1;
            self.state = GraphicalState::Reconnecting;
        }
        self.state
    }

    /// Whether another auto-reconnect attempt is allowed.
    pub fn can_reconnect(&self) -> bool {
        self.reconnect_attempts < self.max_reconnects
    }

    /// Authentication was rejected.
    pub fn auth_failed(&mut self) -> GraphicalState {
        self.state = GraphicalState::AuthFailed;
        self.state
    }

    /// The transport failed to establish.
    pub fn connect_failed(&mut self) -> GraphicalState {
        self.state = GraphicalState::ConnectFailed;
        self.state
    }

    /// The server closed the session cleanly.
    pub fn server_closed(&mut self) -> GraphicalState {
        self.state = GraphicalState::ServerClosed;
        self.state
    }

    /// The user (or a manual dismiss) ended the session. Always terminal.
    pub fn closed(&mut self) -> GraphicalState {
        self.state = GraphicalState::Closed;
        self.state
    }

    /// A manual reconnect from a failed/dropped state restarts the machine.
    pub fn manual_reconnect(&mut self) -> GraphicalState {
        self.state = GraphicalState::Connecting;
        self.reconnect_attempts = 0;
        self.state
    }
}

/// Framebuffer-oriented capability trait, the sibling of
/// [`ConnectionType`](super::ConnectionType).
///
/// Exposed via [`ConnectionType::graphical()`](super::ConnectionType::graphical)
/// once a graphical connection is connected. All methods take `&self` (interior
/// mutability behind channels/mutexes) so a single `&dyn GraphicalBackend` can
/// be shared by the frame pump and the command handlers.
#[async_trait::async_trait]
pub trait GraphicalBackend: Send + Sync {
    /// Static capability descriptor (auth kinds, dynamic resize, clipboard, view-only).
    fn graphical_capabilities(&self) -> GraphicalCapabilities;

    /// Subscribe to decoded frame updates.
    ///
    /// Returns a receiver yielding [`FrameUpdate`]s. Like
    /// [`ConnectionType::subscribe_output`](super::ConnectionType::subscribe_output),
    /// only one subscriber is active at a time; calling again replaces it.
    fn subscribe_frames(&self) -> FrameReceiver;

    /// Subscribe to cursor updates.
    fn subscribe_cursor(&self) -> CursorReceiver;

    /// Forward a protocol-agnostic input event to the remote.
    ///
    /// No-op when the session is view-only.
    async fn send_input(&self, event: InputEvent) -> Result<(), SessionError>;

    /// Request a new session resolution in pixels.
    ///
    /// Backends that cannot resize the remote keep the negotiated resolution and
    /// return `Ok(())`; the frontend scales the canvas instead.
    async fn resize(&self, width_px: u16, height_px: u16) -> Result<(), SessionError>;

    /// Ask the backend to re-emit a full framebuffer frame.
    ///
    /// Used when a window (re)attaches to a still-live session — a cross-window
    /// tab move (#1904). The framebuffer is canvas memory in the source window
    /// and cannot cross a native-window boundary, so the destination canvas is
    /// blank/stale until the next full frame. This forces a prompt repaint
    /// instead of waiting for the protocol's next natural keyframe. Backends that
    /// cannot force a keyframe return `Ok(())` (the default); the frontend then
    /// simply waits for the next natural frame.
    async fn request_full_frame(&self) -> Result<(), SessionError> {
        Ok(())
    }

    /// Read the remote clipboard text, if any / supported.
    async fn get_clipboard(&self) -> Option<String>;

    /// Push local clipboard text to the remote.
    async fn set_clipboard(&self, text: String) -> Result<(), SessionError>;

    /// The files the remote most recently copied to its clipboard, surfaced for a
    /// local paste (#1793). Empty when the backend does not support remote→host
    /// file transfer, the feature is not opted in, or the remote copied no files
    /// (it copied text, an image, or nothing). The bytes are **not** fetched here
    /// — that is deferred to [`Self::fetch_remote_clipboard_file`], which pulls
    /// them on the paste gesture (delayed rendering). Defaults to empty.
    async fn remote_clipboard_files(&self) -> Vec<RemoteClipboardFile> {
        Vec::new()
    }

    /// Fetch the bytes of one surfaced remote-clipboard file on demand (delayed
    /// rendering, #1793), streaming them into a sanitized, bounded local staging
    /// file and returning its path. `index` is the
    /// [`RemoteClipboardFile::index`] of an entry a prior
    /// [`Self::remote_clipboard_files`] surfaced — the only files a fetch can
    /// name. Backends without remote→host file transfer return
    /// [`SessionError::NotRunning`]. Defaults to unsupported.
    async fn fetch_remote_clipboard_file(
        &self,
        index: u32,
    ) -> Result<std::path::PathBuf, SessionError> {
        let _ = index;
        Err(SessionError::NotRunning(
            "remote clipboard file transfer is not supported by this backend".to_string(),
        ))
    }

    /// Subscribe to interactive server-certificate trust prompts (#1767).
    ///
    /// Backends that never need a trust decision (VNC, the mock) return `None`
    /// (the default); the RDP sidecar returns a receiver that yields a
    /// [`CertPrompt`] whenever the server presents an untrusted certificate. The
    /// [`GraphicalSessionManager`](../../../termihub/session) consults its trust
    /// store and either auto-accepts or surfaces the prompt to the user.
    fn subscribe_cert_prompts(&self) -> Option<CertPromptReceiver> {
        None
    }

    /// Deliver the user's (or trust store's) verdict for a pending
    /// [`CertPrompt`] (#1767): `accept` proceeds with the connection, and
    /// `remember` reports whether the host persisted the fingerprint (the
    /// backend does not persist anything itself). No-op for backends that never
    /// prompt.
    async fn send_cert_decision(&self, accept: bool, remember: bool) -> Result<(), SessionError> {
        let _ = (accept, remember);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn _assert_object_safe(_: &dyn GraphicalBackend) {}

    #[test]
    fn dirty_rect_well_formed_check() {
        let ok = DirtyRect {
            x: 0,
            y: 0,
            width: 2,
            height: 1,
            data: vec![0; 8],
        };
        assert!(ok.is_well_formed());
        let bad = DirtyRect {
            x: 0,
            y: 0,
            width: 2,
            height: 1,
            data: vec![0; 7],
        };
        assert!(!bad.is_well_formed());
    }

    #[test]
    fn input_event_serializes_tagged() {
        let ev = InputEvent::Key {
            code: "Enter".to_string(),
            pressed: true,
        };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["kind"], "key");
        assert_eq!(json["code"], "Enter");
        assert_eq!(json["pressed"], true);

        let ptr = InputEvent::Pointer {
            x: 10,
            y: 20,
            buttons: 1,
        };
        let json = serde_json::to_value(&ptr).unwrap();
        assert_eq!(json["kind"], "pointer");
        assert_eq!(json["x"], 10);
    }

    #[test]
    fn graphical_state_serializes_camel_case() {
        let json = serde_json::to_value(GraphicalState::ServerClosed).unwrap();
        assert_eq!(json, serde_json::json!("serverClosed"));
        let json = serde_json::to_value(GraphicalState::Connecting).unwrap();
        assert_eq!(json, serde_json::json!("connecting"));
    }

    #[test]
    fn happy_path_reaches_active() {
        let mut sm = SessionStateMachine::new();
        assert_eq!(sm.state(), GraphicalState::Connecting);
        assert_eq!(sm.transport_up(), GraphicalState::Authenticating);
        assert_eq!(sm.activated(), GraphicalState::Active);
        assert!(sm.state().is_live());
    }

    #[test]
    fn resize_round_trip() {
        let mut sm = SessionStateMachine::new();
        sm.transport_up();
        sm.activated();
        assert_eq!(sm.resize_requested(), GraphicalState::Resizing);
        assert_eq!(sm.resize_complete(), GraphicalState::Active);
    }

    #[test]
    fn resize_requested_only_from_active() {
        let mut sm = SessionStateMachine::new();
        // Still Connecting — resize request must be ignored.
        assert_eq!(sm.resize_requested(), GraphicalState::Connecting);
    }

    #[test]
    fn reconnect_caps_at_three_attempts() {
        let mut sm = SessionStateMachine::new();
        sm.transport_up();
        sm.activated();
        // Drop → Disconnected, then three successful auto-retries.
        for expected in 1..=MAX_RECONNECT_ATTEMPTS {
            assert_eq!(sm.connection_dropped(), GraphicalState::Disconnected);
            assert_eq!(sm.begin_reconnect(), GraphicalState::Reconnecting);
            assert_eq!(sm.reconnect_attempts(), expected);
            // Simulate the retry's transport failing back to a live-less drop:
            // put it back to Disconnected via a fresh live cycle would reset the
            // counter, so instead we model repeated drops without re-activating.
            sm.state = GraphicalState::Active; // pretend it briefly reconnected then dropped
        }
        // Fourth drop: budget exhausted, begin_reconnect stays Disconnected.
        assert_eq!(sm.connection_dropped(), GraphicalState::Disconnected);
        assert_eq!(sm.begin_reconnect(), GraphicalState::Disconnected);
        assert!(!sm.can_reconnect());
    }

    #[test]
    fn activation_resets_reconnect_budget() {
        let mut sm = SessionStateMachine::new();
        sm.transport_up();
        sm.activated();
        sm.connection_dropped();
        sm.begin_reconnect();
        assert_eq!(sm.reconnect_attempts(), 1);
        // A genuine reconnect that reaches Active resets the budget.
        sm.transport_up();
        sm.activated();
        assert_eq!(sm.reconnect_attempts(), 0);
        assert!(sm.can_reconnect());
    }

    #[test]
    fn auth_failure_is_not_live() {
        let mut sm = SessionStateMachine::new();
        sm.transport_up();
        assert_eq!(sm.auth_failed(), GraphicalState::AuthFailed);
        assert!(!sm.state().is_live());
        assert!(!sm.state().is_terminal());
    }

    #[test]
    fn manual_reconnect_restarts() {
        let mut sm = SessionStateMachine::new();
        sm.connect_failed();
        assert!(sm.state().is_terminal());
        assert_eq!(sm.manual_reconnect(), GraphicalState::Connecting);
        assert_eq!(sm.reconnect_attempts(), 0);
    }

    #[test]
    fn closed_and_server_closed_are_terminal() {
        let mut sm = SessionStateMachine::new();
        assert_eq!(sm.closed(), GraphicalState::Closed);
        assert!(sm.state().is_terminal());

        let mut sm2 = SessionStateMachine::new();
        sm2.transport_up();
        sm2.activated();
        assert_eq!(sm2.server_closed(), GraphicalState::ServerClosed);
        assert!(sm2.state().is_terminal());
    }

    #[test]
    fn shared_field_base_groups_and_keys() {
        let groups = shared_field_base(5900);
        let keys: Vec<&str> = groups.iter().map(|g| g.key.as_str()).collect();
        assert_eq!(keys, vec!["connection", "display", "features"]);
        // The shared base carries the credential + display + feature rows the
        // concept lists; a protocol backend appends only its own group.
        let all_field_keys: Vec<&str> = groups
            .iter()
            .flat_map(|g| g.fields.iter())
            .map(|f| f.key.as_str())
            .collect();
        for expected in [
            "host",
            "port",
            "username",
            "password",
            "saveToStore",
            "scaleMode",
            "colorDepth",
            "viewOnly",
            "clipboardSync",
            "autoReconnect",
        ] {
            assert!(
                all_field_keys.contains(&expected),
                "shared base must contain {expected}"
            );
        }
    }

    #[test]
    fn shared_field_base_port_default_is_protocol_supplied() {
        let groups = shared_field_base(3389);
        let port = groups[0].fields.iter().find(|f| f.key == "port").unwrap();
        assert_eq!(port.default, Some(serde_json::json!(3389)));
    }

    #[test]
    fn graphical_capabilities_round_trip() {
        let caps = GraphicalCapabilities {
            auth_kinds: vec![AuthKind::Password, AuthKind::None],
            supports_dynamic_resize: true,
            supports_clipboard: true,
            view_only_capable: true,
        };
        let json = serde_json::to_value(&caps).unwrap();
        assert_eq!(json["supportsDynamicResize"], true);
        assert_eq!(json["viewOnlyCapable"], true);
        let back: GraphicalCapabilities = serde_json::from_value(json).unwrap();
        assert_eq!(back.auth_kinds.len(), 2);
    }
}

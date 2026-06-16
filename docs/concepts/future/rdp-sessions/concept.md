# RDP (Remote Desktop Protocol) Sessions

**GitHub Issue:** [#513](https://github.com/armaxri/termiHub/issues/513)

> **Folder-form concept** (AI-driven concept workflow). Visual surfaces live in
> [`mockups/`](mockups/), behavior diagrams in [`behavior.md`](behavior.md), and the
> concept↔code reconciliation ledger in [`sync.md`](sync.md). The concept is the source of
> truth; run `/sync-concept rdp-sessions` to reconcile it with the implementation.

---

## Overview

Add built-in RDP session support to termiHub, allowing users to connect to Windows remote desktops
directly from within the application. RDP sessions render as graphical tabs alongside terminal tabs,
using the existing tab/split view system.

**Motivation**: RDP is one of the most widely used remote access protocols, especially in enterprise
and Windows environments. System administrators who rely on MobaXterm heavily use RDP sessions
alongside SSH terminals. Adding RDP support makes termiHub a viable MobaXterm replacement for
Windows-centric workflows.

### Key goals

- **Inline graphical sessions**: RDP renders inside a termiHub tab via `<canvas>`, not an external
  window
- **Full tab integration**: RDP tabs participate in drag-and-drop, split views, and the tab bar like
  any other connection type
- **Credential store integration**: RDP passwords stored via the existing credential store (master
  password or prompt-only)
- **Connection editor support**: Schema-driven form for host, port, username, domain, resolution,
  color depth, etc.
- **Cross-platform**: Works on Windows, macOS, and Linux using IronRDP (pure Rust)

### Why IronRDP

| Approach                               | Pros                                                                                         | Cons                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **IronRDP (pure Rust)**                | Cross-platform, no native deps, deep protocol control, MIT-licensed, maintained by Microsoft | Newer library, not feature-complete vs. FreeRDP          |
| **FreeRDP (C library + FFI)**          | Feature-complete, battle-tested, broad codec support                                         | Complex C FFI, difficult cross-compilation, LGPL         |
| **Web-based client (e.g., Guacamole)** | No native code needed                                                                        | Requires server component, latency overhead, extra infra |
| **External viewer launch**             | Trivial to implement                                                                         | Not integrated, no tab support, poor UX                  |

**Recommendation**: Use **IronRDP** as the primary implementation. It is a pure-Rust library
maintained under the Microsoft organization, providing RDP 6+ protocol support with bitmap decoding,
input encoding, and TLS. Its pure-Rust nature means no cross-compilation headaches and no native
dependencies — ideal for termiHub's multi-platform builds.

### Non-Goals

- Multi-monitor remote sessions (single-monitor support only for v1)
- RD Gateway / proxy connections (direct connections only)
- Smart card / certificate authentication (password + NLA only)
- Image clipboard (text clipboard only for v1; image is a stretch goal)

---

## UI Interface

The visual surfaces are specified by the mockups — open them in a browser to review layout and
states. This section describes them; the mockups are authoritative for layout.

| Mockup                                                                     | Shows                                                                                                            |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [`mockups/rdp-session-tab.html`](mockups/rdp-session-tab.html)             | RDP graphical session as a tab (canvas, hover toolbar, status segment); connecting, active, and reconnect states |
| [`mockups/rdp-connection-editor.html`](mockups/rdp-connection-editor.html) | RDP connection editor form — Display / Features / Security groups, scale-mode + color-depth selects              |

### RDP session tab

Once connected, the RDP session renders as a `<canvas>` element filling the tab content area,
alongside normal terminal tabs in the same tab bar. The canvas is a single graphical surface; the
remote desktop's bitmap updates are painted into it. See `mockups/rdp-session-tab.html`.

A thin **floating toolbar** appears at the top of the canvas on hover (similar to a full-screen RDP
client's connection bar), containing:

- **Host badge** — the connected server name with an RDP (`monitor`) icon
- **Resolution indicator** — current display resolution
- **Ctrl+Alt+Del button** (`keyboard` icon) — sends the key combination to the remote session, since
  the local OS would otherwise intercept it
- **Fullscreen toggle** (`maximize` icon) — expands the RDP tab to fill the entire window (hides
  sidebar, activity bar, status bar)

The toolbar auto-hides when the pointer leaves the top region so it does not obscure the desktop.

### Session states in the tab

`mockups/rdp-session-tab.html` shows the three runtime states overlaid on the same canvas surface:

1. **Connecting** — a centered overlay with a `loader` spinner and "Connecting to …" while the TLS
   handshake, authentication, and capability exchange complete. The tab's state dot is amber
   (connecting).
2. **Active** — the canvas renders the live desktop; the floating toolbar is available on hover; the
   tab's state dot is green (connected).
3. **Reconnecting** — a semi-transparent overlay with a `refresh-cw` icon and
   "Connection lost. Reconnecting… (attempt 2/3)" plus a Cancel button, shown when the network drops.
   The tab's state dot is amber.

### Status bar

A dedicated RDP segment appears in the status bar for the active RDP tab: connection-type icon
(`monitor`), `host:port`, current resolution, and color depth — for example
`windows-server.local:3389 · 1920×1080 · 32-bit`. See the status bar in
`mockups/rdp-session-tab.html`.

### Connection editor — RDP configuration

The connection editor uses the existing schema-driven `DynamicForm` system. When the user selects
"RDP" as the connection type, the form renders grouped fields. See
`mockups/rdp-connection-editor.html`:

- **Connection** — Host, Port (default 3389), Username, Domain (optional), Password (with a Save to
  credential store affordance)
- **Display** — Resolution (Match Window / fixed presets / custom), Color Depth (16 / 24 / 32-bit
  select), Scale Mode (Fit to Tab / 1:1 Pixel / Match Window select)
- **Features** — Clipboard Sync, Drive Redirection (with a path picker), Audio Playback,
  Admin/Console Session
- **Security** — Security mode select (Auto / TLS / NLA / RDP) and an "Ignore certificate errors"
  toggle (off by default, shown with a warning)

### Scale modes

The canvas rendering supports three scale modes (decision flow in [`behavior.md`](behavior.md)):

- **Fit to Tab** (default): the remote desktop is scaled to fill the tab area, preserving aspect
  ratio. Good for overview/monitoring.
- **1:1 Pixel**: no scaling. If the remote resolution exceeds the tab size, scrollbars appear. Good
  for precise work.
- **Match Window**: the RDP session resolution dynamically adjusts to match the tab dimensions. On
  tab resize (split view, window resize), a resize request is sent to the RDP server. Good for
  general use.

### Keyboard handling

RDP sessions need special keyboard handling because certain key combinations are intercepted by the
local OS or the WebView. When the RDP canvas has focus, all keyboard events are captured and
forwarded to the remote session:

| Local input                 | Sent to remote as          |
| --------------------------- | -------------------------- |
| Ctrl+Alt+Del toolbar button | Ctrl+Alt+Del               |
| Ctrl+Alt+End                | Ctrl+Alt+Del (alternative) |
| Alt+Tab inside canvas       | Alt+Tab on remote          |
| Win / Cmd key               | Win key on remote          |

A keyboard-capture toggle (`Ctrl+Alt+Shift`) temporarily releases keyboard focus back to termiHub so
the user can switch tabs with `Ctrl+Tab`.

### Clipboard integration

Clipboard sync is bidirectional for text content (sequence in [`behavior.md`](behavior.md)). Image
clipboard support is a stretch goal (requires conversion between Windows CF_DIB and PNG).

### Sidebar — connection list

RDP connections appear in the existing Connections sidebar alongside SSH, telnet, serial, etc.,
distinguished by an RDP-specific `monitor` icon. The right-click context menu offers Connect, Edit,
Duplicate, and Delete. There is no SFTP or file browser option for RDP connections — file transfer is
handled through drive redirection if enabled.

---

## General Handling

Detailed flows — connection lifecycle, authentication, resolution negotiation, input handling, drive
redirection, reconnection, the full session state machine, and the frame-rendering pipeline — are
diagrammed in [`behavior.md`](behavior.md). Key rules:

- **Connection type routing**: terminal connection types (ssh, local, telnet, serial, docker) go
  through `SessionManager`; RDP routes to a separate `RdpManager`. See the routing flowchart in
  [`behavior.md`](behavior.md).
- **Authentication** defaults to NLA (CredSSP); TLS and legacy RDP encryption are available, the
  latter with a security warning. Credentials come from the credential store or a prompt.
- **Dynamic resize** uses the RDP Display Control Channel (RDP 8.1+). Older servers stay at the
  initially negotiated resolution and the canvas scales to fit.
- **Reconnection** retries up to 3 attempts on network drop; the tab shows a reconnect overlay.
- **Focus loss** stops keyboard forwarding and releases held modifier keys to avoid stuck keys.

### Edge Cases

| Scenario                        | Handling                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| **Certificate mismatch**        | Show warning dialog with cert details; user can accept once or permanently for this host    |
| **NLA auth failure**            | Show "Authentication failed. Check username, domain, and password." with retry option       |
| **Server at max sessions**      | Show "Server session limit reached. Try again later or use Admin/Console session."          |
| **Slow network / high latency** | Automatically reduce color depth and disable wallpaper/compositing; show latency indicator  |
| **Remote session locked**       | Send Ctrl+Alt+Del via toolbar to unlock; canvas shows the lock screen                       |
| **Tab loses focus**             | Stop forwarding keyboard events; release all held modifier keys to avoid stuck keys         |
| **Very large resolution**       | Cap at 4096×2160 to prevent excessive memory usage; warn user if requested size exceeds cap |
| **Multi-monitor remote**        | Out of scope for initial implementation; single-monitor support only                        |
| **Gateway/proxy**               | Out of scope for initial implementation; direct connections only                            |
| **Smart card / cert auth**      | Out of scope for initial implementation; password + NLA only                                |

---

## Preliminary Implementation Details

> **Note**: These details reflect the codebase at the time of concept creation. The implementation
> may need to adapt if the codebase evolves before this feature is built. Implementation phases are
> sequenced in the gantt diagram in [`behavior.md`](behavior.md).

### Crate Dependency: IronRDP

Add `ironrdp` to the workspace dependencies. IronRDP is modular — only include the needed sub-crates:

```toml
# src-tauri/Cargo.toml
[dependencies]
ironrdp-client = "0.x"       # High-level client API
ironrdp-graphics = "0.x"     # Bitmap decoding (RFX, NSCodec, planar)
ironrdp-input = "0.x"        # Keyboard/mouse input encoding
ironrdp-cliprdr = "0.x"      # Clipboard redirection channel
ironrdp-rdpdr = "0.x"        # Drive redirection channel (optional)
ironrdp-displaycontrol = "0.x" # Dynamic resolution (optional)
ironrdp-tls = "0.x"          # TLS transport
ironrdp-connector = "0.x"    # Connection/auth flow
```

### Backend: RDP Session Manager

Create `src-tauri/src/rdp/` as a new module:

```
src-tauri/src/rdp/
  mod.rs            # RdpManager — holds active sessions, frame buffers
  session.rs        # RdpSession — wraps IronRDP client, manages lifecycle
  input.rs          # Input event conversion (browser events → RDP scancodes)
  clipboard.rs      # Clipboard channel handling (CLIPRDR)
  config.rs         # RdpConfig struct and validation
```

#### RdpConfig (Rust)

```rust
/// RDP connection configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpConfig {
    pub host: String,
    #[serde(default = "default_rdp_port")]
    pub port: u16,
    pub username: String,
    pub domain: Option<String>,
    #[serde(skip_serializing)]
    pub password: Option<String>,
    pub save_password: bool,

    // Display
    #[serde(default)]
    pub resolution: RdpResolution,
    #[serde(default = "default_color_depth")]
    pub color_depth: u8,  // 16, 24, or 32
    #[serde(default)]
    pub scale_mode: RdpScaleMode,

    // Features
    #[serde(default = "default_true")]
    pub clipboard_sync: bool,
    pub drive_redirection: Option<DriveRedirection>,
    #[serde(default)]
    pub audio_playback: bool,
    #[serde(default)]
    pub admin_session: bool,

    // Security
    #[serde(default)]
    pub security_mode: RdpSecurityMode,
    #[serde(default)]
    pub ignore_certificate_errors: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum RdpResolution {
    #[default]
    MatchWindow,
    Fixed { width: u16, height: u16 },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum RdpScaleMode {
    #[default]
    FitToTab,
    OneToOne,
    MatchWindow,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum RdpSecurityMode {
    #[default]
    Auto,
    Nla,
    Tls,
    Rdp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveRedirection {
    pub local_path: String,
    pub drive_name: Option<String>,  // default: "termiHub"
}

fn default_rdp_port() -> u16 { 3389 }
fn default_color_depth() -> u8 { 32 }
fn default_true() -> bool { true }
```

#### RdpManager

```rust
pub struct RdpManager {
    sessions: HashMap<String, RdpSession>,
    app_handle: AppHandle,
}

impl RdpManager {
    /// Create and connect a new RDP session. Returns the session ID.
    pub async fn create_session(&mut self, config: RdpConfig) -> anyhow::Result<String>;

    /// Send keyboard/mouse input to a session.
    pub async fn send_input(&self, session_id: &str, event: RdpInputEvent) -> anyhow::Result<()>;

    /// Send clipboard data to a session.
    pub async fn send_clipboard(&self, session_id: &str, data: ClipboardData) -> anyhow::Result<()>;

    /// Resize the session display.
    pub async fn resize(&self, session_id: &str, width: u16, height: u16) -> anyhow::Result<()>;

    /// Disconnect and clean up a session.
    pub async fn close_session(&mut self, session_id: &str) -> anyhow::Result<()>;
}
```

Each `RdpSession` runs its IronRDP client on a dedicated tokio task. Frame updates are emitted as
Tauri events with the dirty region's pixel data.

#### Frame Data Transfer

The main performance challenge is transferring bitmap data from Rust to the frontend efficiently. The
options and recommendation are diagrammed in [`behavior.md`](behavior.md). **Recommended**: use Tauri
2's native byte array support in events. Dirty regions are typically small (a few KB to a few hundred
KB), making per-event overhead acceptable. For full-screen updates, consider chunking into tiles.

The backend maintains a full framebuffer in Rust memory. On each bitmap update, only the changed
(dirty) region is decoded and sent to the frontend as raw RGBA pixel data. The frontend uses
`CanvasRenderingContext2D.putImageData()` to update only the dirty rectangle.

### Tauri Commands (`src-tauri/src/commands/rdp.rs`)

```rust
#[tauri::command]
async fn create_rdp_session(
    config: RdpConfig,
    tab_width: u16,
    tab_height: u16,
    manager: State<'_, Mutex<RdpManager>>,
    credentials: State<'_, CredentialManager>,
) -> Result<RdpSessionInfo, TerminalError>;

#[tauri::command]
async fn rdp_send_input(
    session_id: String,
    event: RdpInputEvent,
    manager: State<'_, Mutex<RdpManager>>,
) -> Result<(), TerminalError>;

#[tauri::command]
async fn rdp_send_clipboard(
    session_id: String,
    data: ClipboardData,
    manager: State<'_, Mutex<RdpManager>>,
) -> Result<(), TerminalError>;

#[tauri::command]
async fn rdp_resize(
    session_id: String,
    width: u16,
    height: u16,
    manager: State<'_, Mutex<RdpManager>>,
) -> Result<(), TerminalError>;

#[tauri::command]
async fn close_rdp_session(
    session_id: String,
    manager: State<'_, Mutex<RdpManager>>,
) -> Result<(), TerminalError>;
```

### Tauri Events

| Event                              | Payload                         | Description                                   |
| ---------------------------------- | ------------------------------- | --------------------------------------------- |
| `rdp:{sessionId}:connected`        | `{width, height}`               | Session established, canvas should initialize |
| `rdp:{sessionId}:frame`            | `{x, y, w, h, pixels: Vec<u8>}` | Dirty region bitmap (RGBA)                    |
| `rdp:{sessionId}:disconnected`     | `{reason, recoverable}`         | Session ended or lost                         |
| `rdp:{sessionId}:clipboard`        | `{format, data}`                | Remote clipboard update                       |
| `rdp:{sessionId}:error`            | `{message}`                     | Non-fatal error notification                  |
| `rdp:{sessionId}:resize-confirmed` | `{width, height}`               | Server confirmed new resolution               |

### Frontend: TypeScript Types

Add to `src/types/terminal.ts`:

```typescript
export type TabContentType =
  | "terminal"
  | "settings"
  | "editor"
  | "connection-editor"
  | "log-viewer"
  | "tunnel-editor"
  | "workspace-editor"
  | "rdp"; // New

export interface RdpTabMeta {
  host: string;
  port: number;
  username: string;
  domain?: string;
  scaleMode: "fit" | "1:1" | "match";
}
```

Extend `TerminalTab`:

```typescript
export interface TerminalTab {
  // ... existing fields
  rdpMeta?: RdpTabMeta;
}
```

### Frontend: New Components

```
src/components/Rdp/
  RdpPanel.tsx          # Main RDP tab panel — canvas + toolbar + event handlers
  RdpToolbar.tsx        # Floating toolbar (host, resolution, Ctrl+Alt+Del, fullscreen)
  RdpCanvas.tsx         # Canvas element with input capture and frame rendering
  useRdpSession.ts      # Hook: manages session lifecycle, event listeners, input forwarding
```

#### RdpCanvas Component (Sketch)

```typescript
interface RdpCanvasProps {
  sessionId: string;
  width: number;
  height: number;
  scaleMode: "fit" | "1:1" | "match";
  onDisconnected: (reason: string) => void;
}

export function RdpCanvas({ sessionId, width, height, scaleMode, onDisconnected }: RdpCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Listen for frame events, render dirty regions
  useEffect(() => {
    const unlisten = listen<FrameEvent>(`rdp:${sessionId}:frame`, (event) => {
      const ctx = canvasRef.current?.getContext("2d");
      if (!ctx) return;
      const { x, y, w, h, pixels } = event.payload;
      const imageData = new ImageData(new Uint8ClampedArray(pixels), w, h);
      ctx.putImageData(imageData, x, y);
    });
    return () => { unlisten.then(fn => fn()); };
  }, [sessionId]);

  // Capture and forward keyboard/mouse events
  // ...

  return <canvas ref={canvasRef} width={width} height={height} tabIndex={0} />;
}
```

#### useRdpSession Hook

```typescript
function useRdpSession(config: ConnectionConfig) {
  const [state, setState] = useState<"connecting" | "connected" | "disconnected" | "error">(
    "connecting"
  );
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [resolution, setResolution] = useState({ width: 0, height: 0 });

  // Connect, listen for events, handle lifecycle
  // Returns: { state, sessionId, resolution, sendInput, resize, disconnect }
}
```

### API Layer (`src/services/api.ts`)

```typescript
export async function createRdpSession(
  config: Record<string, unknown>,
  tabWidth: number,
  tabHeight: number
): Promise<{ sessionId: string; width: number; height: number }> {
  return invoke("create_rdp_session", { config, tabWidth, tabHeight });
}

export async function rdpSendInput(sessionId: string, event: RdpInputEvent): Promise<void> {
  return invoke("rdp_send_input", { sessionId, event });
}

export async function rdpResize(sessionId: string, width: number, height: number): Promise<void> {
  return invoke("rdp_resize", { sessionId, width, height });
}

export async function closeRdpSession(sessionId: string): Promise<void> {
  return invoke("close_rdp_session", { sessionId });
}
```

### Store Extensions (`src/store/appStore.ts`)

Add `openRdpTab(config)` action following the existing `openSettingsTab` / `createTab` patterns. The
action creates a tab with `contentType: "rdp"` and `rdpMeta` populated from the connection config.

### Connection Type Registration

Register `"rdp"` in the `ConnectionTypeRegistry` with:

- **type_id**: `"rdp"`
- **display_name**: `"RDP (Remote Desktop)"`
- **icon**: `"monitor"` (or custom RDP icon)
- **capabilities**: `{ resize: true, clipboard: true }` (no monitoring, no file_browser)
- **settings_schema**: JSON schema for the connection editor form (host, port, username, domain,
  resolution, color depth, features, security)

Since RDP is not a terminal connection, the `ConnectionType` trait does not fit directly (it's
designed for byte-stream I/O via `write()` and `subscribe_output()`). Instead, the RDP backend
registers as a separate manager (`RdpManager`) alongside the `SessionManager`, with its own set of
Tauri commands. The connection editor and sidebar still use the `ConnectionTypeRegistry` for
discovery and schema, but session lifecycle is handled through the RDP-specific commands. The routing
decision is diagrammed in [`behavior.md`](behavior.md).

### Files to Create or Modify

| File                                     | Change                                                    |
| ---------------------------------------- | --------------------------------------------------------- |
| `src-tauri/src/rdp/mod.rs`               | **New** — RdpManager, session lifecycle                   |
| `src-tauri/src/rdp/session.rs`           | **New** — RdpSession wrapping IronRDP client              |
| `src-tauri/src/rdp/input.rs`             | **New** — Browser input → RDP scancode conversion         |
| `src-tauri/src/rdp/clipboard.rs`         | **New** — CLIPRDR channel handling                        |
| `src-tauri/src/rdp/config.rs`            | **New** — RdpConfig, validation                           |
| `src-tauri/src/commands/rdp.rs`          | **New** — Tauri RDP commands                              |
| `src-tauri/src/lib.rs`                   | Register RdpManager as managed state, register commands   |
| `src-tauri/Cargo.toml`                   | Add ironrdp dependencies                                  |
| `src/components/Rdp/RdpPanel.tsx`        | **New** — Main RDP tab component                          |
| `src/components/Rdp/RdpToolbar.tsx`      | **New** — Floating toolbar                                |
| `src/components/Rdp/RdpCanvas.tsx`       | **New** — Canvas rendering + input                        |
| `src/hooks/useRdpSession.ts`             | **New** — RDP session lifecycle hook                      |
| `src/types/terminal.ts`                  | Add `"rdp"` to `TabContentType`, add `RdpTabMeta`         |
| `src/services/api.ts`                    | Add RDP command wrappers                                  |
| `src/store/appStore.ts`                  | Add `openRdpTab` action                                   |
| `src/components/SplitView/SplitView.tsx` | Add rendering branch for `contentType === "rdp"`          |
| `src/components/StatusBar/StatusBar.tsx` | Add RDP-specific status display (resolution, color depth) |

### Security Considerations

- **Credential handling**: RDP passwords flow through the existing credential store — never stored in
  plaintext in connection configs. The `password` field in `RdpConfig` is `skip_serializing`.
- **Certificate validation**: By default, validate server certificates. The "ignore certificate
  errors" option is off by default and shown with a warning in the connection editor.
- **NLA enforcement**: Default to NLA (CredSSP) which authenticates before the RDP session starts,
  preventing unauthorized resource consumption on the server.
- **Input sanitization**: All user-provided config values (host, username, domain, paths) are
  validated before use. Drive redirection paths are restricted to prevent path traversal.
- **No legacy encryption by default**: RDP-level encryption (no TLS) is available for compatibility
  but disabled by default and shown with a security warning.

---

## Implementation Status

Not started — this is a `future/` concept. Once implementation begins, run
`/sync-concept rdp-sessions` after each change to keep [`sync.md`](sync.md) current.

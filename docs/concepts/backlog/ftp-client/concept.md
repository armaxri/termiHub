# Concept: FTP Client Sessions

**GitHub Issue:** [#518](https://github.com/armaxri/termiHub/issues/518)

> **Folder-form concept** (AI-driven concept workflow). Visual surfaces live in
> [`mockups/`](mockups/), behavior diagrams in [`behavior.md`](behavior.md), and the
> concept↔code reconciliation ledger in [`sync.md`](sync.md). The concept is the source of
> truth; run `/sync-concept ftp-client` to reconcile it with the implementation.

---

## Overview

Add FTP (File Transfer Protocol) client support to termiHub, enabling users to connect to FTP
servers for file browsing and transfer. FTP sessions integrate with the existing file browser
sidebar, connection editor, and credential store — leveraging termiHub's schema-driven
architecture so that no custom UI code is required.

While SFTP has largely replaced FTP for secure transfers, FTP remains common in legacy
environments, embedded systems, network equipment, and some hosting providers. Supporting FTP
(plain and FTPS) broadens termiHub's compatibility with older infrastructure.

### Goals

- Support FTP (plain), FTPS explicit (STARTTLS), and FTPS implicit (TLS from the start)
- Integrate with the existing file browser sidebar for directory navigation and file operations
- Provide a transfer queue with progress tracking for uploads and downloads
- Warn users when connecting over plain FTP (unencrypted credentials on the wire)
- Support passive mode (default, firewall-friendly) and active mode as fallback
- Support transfer resume for interrupted uploads/downloads where the server supports it

### Non-Goals

- SFTP support (already handled by the SSH backend)
- FTP proxy/gateway functionality
- FTP server hosting

---

## UI Interface

The visual surfaces are specified by the mockups — open them in a browser to review layout and
states. This section describes them; the mockups are authoritative for layout.

| Mockup                                                                               | Shows                                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`mockups/ftp-transfer-queue.html`](mockups/ftp-transfer-queue.html)                 | **Primary** — Transfer Queue panel above the status bar: active (with progress bar), paused, queued, completed, failed/retry rows; multiple-active and minimized panel states |
| [`mockups/ftp-connection-and-warning.html`](mockups/ftp-connection-and-warning.html) | Schema-driven FTP connection editor (TLS-mode conditional fields, anonymous toggle) and the insecure-FTP warning modal                                                        |

### Connection editor

FTP connections use the existing generic connection editor with a schema-driven form rendered by
`DynamicForm` — there is no hand-coded FTP UI. Selecting "FTP" as the connection type reveals
Server (Host, Port), Security (TLS Mode), Authentication (Anonymous toggle, Username, Password),
and Transfer (Mode, Transfer type, Initial Directory, Timeout) groups. Conditional field
visibility:

- When **Anonymous** is checked, Username is set to `anonymous` and the Username / Password rows
  are hidden.
- The plain-FTP security warning is only shown when TLS Mode is **None**.
- Port auto-adjusts to 990 when TLS Mode is **Implicit**, 21 otherwise (user can override).

See `mockups/ftp-connection-and-warning.html`.

### File browser sidebar

FTP sessions appear in the file browser sidebar, reusing the same tree-view UI as SFTP for
directory navigation, previews, and the file context menu (Download, Upload Here, New Folder,
Rename, Delete, Refresh, Copy Path, Properties).

### Transfer queue panel

A transfer queue panel docks above the status bar whenever transfers are active. It is
**connection-type agnostic** — shared across all sessions that support file transfer (FTP now,
potentially SFTP later). Each row shows direction (up/down), file name, remote path, a progress
bar, percent, throughput, and per-transfer controls. The state space — active, paused, queued,
completed, failed/retry — plus the minimized (status-bar indicator only) state are all in the
primary mockup. Footer actions are **Clear Completed** and **Cancel All**. See
`mockups/ftp-transfer-queue.html`.

### Security warning dialog

Connecting via plain FTP (no TLS) shows a modal warning before the control connection opens. The
user can **Connect Anyway**, **Cancel**, or tick "Don't warn again for this connection" (sets
`suppressSecurityWarning`). See `mockups/ftp-connection-and-warning.html`.

---

## General Handling

Detailed flows, the connection and transfer state machines, the reconnection path, and edge cases
are diagrammed in [`behavior.md`](behavior.md). Key rules:

### Connection lifecycle

1. **Create** — User creates an FTP connection via the connection editor; settings are validated
   and saved to `connections.json`.
2. **Connect** — The backend establishes a control connection, authenticates, and optionally
   negotiates TLS. On plain FTP, the security warning appears first.
3. **Browse** — The file browser sidebar populates with the remote listing; the user navigates,
   previews text files, and initiates transfers.
4. **Transfer** — Uploads/downloads are queued and executed; progress is reported in the transfer
   queue panel.
5. **Disconnect** — The control connection is gracefully terminated (`QUIT`); active transfers are
   cancelled with a confirmation prompt.

### FTP-specific behaviors

- **No terminal output**: FTP sessions open directly into the file browser view — no terminal tab
  is created.
- **Keep-alive**: periodic `NOOP` commands prevent idle-connection drops (default 60 s,
  configurable).
- **Reconnection**: on control-connection drop, the backend auto-reconnects (up to 3 retries);
  active transfers pause and resume after reconnection.
- **Transfer types**: Binary (default) preserves contents exactly; ASCII converts line endings.
  Default is configurable and overridable per transfer.
- **Passive vs Active mode**: Passive (default) works through NAT/firewalls; Active requires the
  client to be directly reachable.
- **Directory listing parsing**: servers return varied listing formats (Unix `ls -l`, Windows,
  MLSD); the backend parses multiple formats consistently.

### Transfer queue behavior

- Transfers are queued globally per FTP session.
- Maximum concurrent transfers per session: 2 (configurable, separate data connections).
- Failed transfers retry up to 3 times automatically with exponential backoff.
- Transfer resume: where the server supports `REST`, interrupted downloads resume from the last
  byte received.
- Large transfers show estimated time remaining from current throughput.
- Completed transfers remain visible until explicitly cleared.

### Credential handling

- Passwords are stored in the credential store (matching the user's credential storage mode).
- Anonymous login uses username `anonymous` with a configurable email-style password (defaults to
  empty).
- Passwords are never written to `connections.json` or logs.

### Edge cases

- **Server compatibility**: handle common quirks gracefully (e.g. fall back from `MLSD` to
  `LIST`).
- **Symbolic links**: distinct icon, followed for navigation, target shown in properties.
- **Large directories**: virtual scrolling avoids UI freezes for thousands of entries.
- **Filename encoding**: assume UTF-8 with Latin-1 fallback; selectable encoding is a future
  enhancement.
- **Connection timeout**: surface a clear error with suggestions (check host/port, firewall,
  server status).

---

## Preliminary Implementation Details

Based on the current project architecture at concept-creation time; the codebase may evolve before
implementation. The integration and agent-support diagrams live in [`behavior.md`](behavior.md).

### New crate dependency

Add the [`suppaftp`](https://crates.io/crates/suppaftp) crate to `core/Cargo.toml`:

```toml
[dependencies]
suppaftp = { version = "6", features = ["async-native-tls"] }
```

`suppaftp` supports FTP, FTPS (explicit and implicit), passive and active mode, and async
operations via `async-native-tls`. It handles the FTP protocol details, including `PASV`/`EPSV`,
`REST`, `MLSD`/`LIST`, and TLS negotiation.

### New backend: `core/src/backends/ftp/`

```
core/src/backends/ftp/
  mod.rs              # FtpBackend — implements ConnectionType
  file_browser.rs     # FtpFileBrowser — implements FileBrowser
  transfer.rs         # TransferQueue, TransferEntry, progress tracking
  listing_parser.rs   # Directory listing parsers (Unix, Windows, MLSD)
```

**FtpBackend** (`mod.rs`):

```rust
pub struct FtpBackend {
    client: Option<AsyncFtpStream>,
    settings: FtpSettings,
    keep_alive_handle: Option<JoinHandle<()>>,
    file_browser: Option<FtpFileBrowser>,
    transfer_queue: TransferQueue,
    output_tx: Option<broadcast::Sender<Vec<u8>>>,
}

impl ConnectionType for FtpBackend {
    fn type_id(&self) -> &str { "ftp" }
    fn display_name(&self) -> &str { "FTP" }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: true,
            resize: false,
            persistent: false,
        }
    }

    fn settings_schema(&self) -> SettingsSchema {
        // Schema-driven fields: host, port, tls_mode,
        // username, password, anonymous, passive_mode,
        // transfer_type, initial_directory, timeout,
        // keep_alive_interval, suppress_security_warning
    }

    async fn connect(&mut self, settings: Value) -> Result<(), SessionError> {
        // 1. Parse settings
        // 2. Establish TCP connection
        // 3. Negotiate TLS if configured
        // 4. Authenticate (user/pass or anonymous)
        // 5. Set passive/active mode
        // 6. Change to initial directory
        // 7. Start keep-alive task
        // 8. Initialize FtpFileBrowser
    }

    async fn write(&mut self, _data: &[u8]) -> Result<(), SessionError> {
        // FTP has no terminal input — return error or no-op
        Err(SessionError::NotSupported("FTP has no terminal input"))
    }

    async fn resize(&mut self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        Ok(()) // No-op, FTP has no terminal
    }

    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        self.file_browser.as_ref().map(|fb| fb as &dyn FileBrowser)
    }

    async fn disconnect(&mut self) -> Result<(), SessionError> {
        // Cancel active transfers, send QUIT, close connection
    }
}
```

**FtpFileBrowser** (`file_browser.rs`):

```rust
pub struct FtpFileBrowser {
    client: Arc<Mutex<AsyncFtpStream>>,
}

#[async_trait]
impl FileBrowser for FtpFileBrowser {
    async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, FileError> {
        // Try MLSD first (structured listing), fall back to LIST
        // Parse listing into Vec<FileEntry>
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, FileError> {
        // RETR file into memory (for preview/edit)
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), FileError> {
        // STOR file from memory
    }

    async fn delete(&self, path: &str) -> Result<(), FileError> {
        // DELE for files, RMD for directories
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), FileError> {
        // RNFR + RNTO
    }

    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        // MLST if supported, otherwise LIST parent + filter
    }
}
```

### Transfer queue

The transfer queue manages concurrent file transfers with progress reporting.

```rust
// core/src/backends/ftp/transfer.rs

pub struct TransferQueue {
    entries: Vec<TransferEntry>,
    max_concurrent: usize,
    progress_tx: broadcast::Sender<TransferProgress>,
}

pub struct TransferEntry {
    pub id: String,
    pub direction: TransferDirection,  // Upload / Download
    pub local_path: PathBuf,
    pub remote_path: String,
    pub state: TransferState,
    pub total_bytes: Option<u64>,
    pub transferred_bytes: u64,
    pub speed_bytes_per_sec: u64,
}

pub enum TransferState {
    Queued,
    Active,
    Paused,
    Completed,
    Failed(String),
    Cancelled,
}
```

### New Tauri IPC commands

Add FTP-specific transfer commands in `src-tauri/src/commands/`:

```rust
// src-tauri/src/commands/ftp.rs

#[tauri::command]
async fn ftp_download(
    session_id: String,
    remote_path: String,
    local_path: String,
) -> Result<String, String>;  // Returns transfer ID

#[tauri::command]
async fn ftp_upload(
    session_id: String,
    local_path: String,
    remote_path: String,
) -> Result<String, String>;  // Returns transfer ID

#[tauri::command]
async fn ftp_transfer_pause(transfer_id: String) -> Result<(), String>;

#[tauri::command]
async fn ftp_transfer_resume(transfer_id: String) -> Result<(), String>;

#[tauri::command]
async fn ftp_transfer_cancel(transfer_id: String) -> Result<(), String>;

#[tauri::command]
async fn ftp_transfer_list(session_id: String) -> Result<Vec<TransferEntry>, String>;
```

### Frontend store extensions

Add transfer queue state to `src/store/appStore.ts`:

```typescript
// Transfer queue types (src/types/transfer.ts)
export interface TransferEntry {
  id: string;
  sessionId: string;
  direction: "upload" | "download";
  localPath: string;
  remotePath: string;
  state: "queued" | "active" | "paused" | "completed" | "failed" | "cancelled";
  totalBytes: number | null;
  transferredBytes: number;
  speedBytesPerSec: number;
  error: string | null;
}

// Store slice
interface TransferSlice {
  transfers: TransferEntry[];
  addTransfer: (entry: TransferEntry) => void;
  updateTransfer: (id: string, update: Partial<TransferEntry>) => void;
  removeTransfer: (id: string) => void;
  clearCompleted: () => void;
}
```

### New frontend components

```
src/components/TransferQueue/
  TransferQueue.tsx           # Transfer queue panel (status bar area)
  TransferEntry.tsx           # Individual transfer row with progress bar
  TransferControls.tsx        # Pause/resume/cancel/retry buttons
```

The transfer queue panel is connection-type agnostic — it listens for transfer events from any
session that supports file transfers.

### Tauri event integration

Transfer progress is reported via Tauri events (not polling):

```rust
// Backend emits progress events
app_handle.emit("transfer-progress", TransferProgressPayload {
    transfer_id: id,
    transferred_bytes: bytes,
    total_bytes: total,
    speed: speed,
    state: state,
});
```

```typescript
// Frontend listens for progress
import { listen } from "@tauri-apps/api/event";

listen<TransferProgressPayload>("transfer-progress", (event) => {
  useAppStore.getState().updateTransfer(event.payload.transfer_id, {
    transferredBytes: event.payload.transferred_bytes,
    speedBytesPerSec: event.payload.speed,
    state: event.payload.state,
  });
});
```

### Settings schema definition

The FTP backend declares its settings schema so the connection editor renders automatically:

```rust
fn settings_schema(&self) -> SettingsSchema {
    SettingsSchema {
        groups: vec![
            SettingsGroup {
                label: "Server",
                fields: vec![
                    Field { key: "host", label: "Host", field_type: Text, required: true },
                    Field { key: "port", label: "Port", field_type: Port, default: 21 },
                ],
            },
            SettingsGroup {
                label: "Security",
                fields: vec![
                    Field {
                        key: "tlsMode",
                        label: "TLS Mode",
                        field_type: Select(vec!["none", "explicit", "implicit"]),
                        default: "none",
                    },
                    // Security warning rendered by frontend when tlsMode == "none"
                    Field {
                        key: "suppressSecurityWarning",
                        label: "Don't warn about insecure connection",
                        field_type: Boolean,
                        default: false,
                        visible_when: FieldCondition { key: "tlsMode", equals: "none" },
                    },
                ],
            },
            SettingsGroup {
                label: "Authentication",
                fields: vec![
                    Field {
                        key: "anonymous",
                        label: "Use anonymous login",
                        field_type: Boolean,
                        default: false,
                    },
                    Field {
                        key: "username",
                        label: "Username",
                        field_type: Text,
                        default: "",
                        visible_when: FieldCondition { key: "anonymous", equals: false },
                    },
                    Field {
                        key: "password",
                        label: "Password",
                        field_type: Password,
                        visible_when: FieldCondition { key: "anonymous", equals: false },
                    },
                ],
            },
            SettingsGroup {
                label: "Transfer",
                fields: vec![
                    Field {
                        key: "passiveMode",
                        label: "Mode",
                        field_type: Select(vec!["passive", "active"]),
                        default: "passive",
                    },
                    Field {
                        key: "transferType",
                        label: "Transfer Type",
                        field_type: Select(vec!["binary", "ascii"]),
                        default: "binary",
                    },
                    Field {
                        key: "initialDirectory",
                        label: "Initial Directory",
                        field_type: Text,
                        default: "/",
                    },
                    Field {
                        key: "timeout",
                        label: "Timeout (seconds)",
                        field_type: Number,
                        default: 30,
                    },
                ],
            },
        ],
    }
}
```

### Registration

Register the FTP backend in the connection type registry:

```rust
// core/src/backends/mod.rs
pub mod ftp;

// In the registry setup (desktop or agent)
registry.register(Box::new(FtpBackend::new()));
```

### Implementation order

1. Core `FtpBackend` skeleton + settings schema + connection/auth/TLS (`mod.rs`).
2. `FtpFileBrowser` + listing parsers; wire into the file browser sidebar.
3. `TransferQueue` core + Tauri IPC commands + progress events.
4. Frontend transfer store slice + `TransferQueue` panel/rows/controls.
5. Insecure-FTP warning modal + schema-conditional fields in the editor.
6. Polish & edge cases (reconnection, resume, encoding fallback, server quirks).

### File touched summary

| File/Directory                                      | Action | Purpose                              |
| --------------------------------------------------- | ------ | ------------------------------------ |
| `core/Cargo.toml`                                   | Modify | Add `suppaftp` dependency            |
| `core/src/backends/ftp/mod.rs`                      | Create | FtpBackend implementation            |
| `core/src/backends/ftp/file_browser.rs`             | Create | FtpFileBrowser implementation        |
| `core/src/backends/ftp/transfer.rs`                 | Create | Transfer queue logic                 |
| `core/src/backends/ftp/listing_parser.rs`           | Create | Directory listing parsers            |
| `core/src/backends/mod.rs`                          | Modify | Register FTP module                  |
| `src-tauri/src/commands/ftp.rs`                     | Create | Tauri IPC commands for transfers     |
| `src-tauri/src/commands/mod.rs`                     | Modify | Register FTP commands                |
| `src/types/transfer.ts`                             | Create | Transfer queue TypeScript types      |
| `src/store/appStore.ts`                             | Modify | Add transfer slice                   |
| `src/services/api.ts`                               | Modify | Add FTP transfer API functions       |
| `src/services/events.ts`                            | Modify | Add transfer progress event listener |
| `src/components/TransferQueue/TransferQueue.tsx`    | Create | Transfer queue panel                 |
| `src/components/TransferQueue/TransferEntry.tsx`    | Create | Transfer row component               |
| `src/components/TransferQueue/TransferControls.tsx` | Create | Transfer action buttons              |

---

## Implementation Status

Not started — this is a `backlog/` concept. Once implementation begins, run
`/sync-concept ftp-client` after each change to keep [`sync.md`](sync.md) current.

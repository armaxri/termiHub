# Behavior — Elevated SFTP Editing + Early Read-Only Detection

**GitHub Issue:** [#970](https://github.com/armaxri/termiHub/issues/970)

Companion to [`concept.md`](concept.md). State machines and sequence diagrams for read-only
detection on open, the elevated-save flow, and the sudo prompt / retry / failure paths.

---

## Editor writability state machine

```mermaid
stateDiagram-v2
    [*] --> Loading
    Loading --> Probing: content loaded
    Probing --> Writable: writable / unknown
    Probing --> ReadOnlyShell: not writable + shell available
    Probing --> ReadOnlyNoShell: not writable + SFTP-only

    Writable --> Writable: edit
    Writable --> [*]: save (direct) OK
    Writable --> SaveFailed: save (direct) fails

    ReadOnlyShell --> ReadOnlyShell: edit (buffer only)
    ReadOnlyShell --> Prompting: Edit/Save with sudo
    Prompting --> Elevated: password accepted
    Prompting --> ReadOnlyShell: cancel
    Prompting --> Prompting: wrong password (retry < 3)
    Prompting --> SaveFailed: 3 failures / non-password error

    Elevated --> Elevated: edit / save OK
    Elevated --> SaveFailed: elevated save fails

    ReadOnlyNoShell --> ReadOnlyNoShell: edit (buffer only)
    ReadOnlyNoShell --> SaveCopy: Save a copy...
    SaveCopy --> [*]: written to writable path / downloaded

    SaveFailed --> ReadOnlyShell: dismiss (cached pw cleared if wrong)
    SaveFailed --> Elevated: dismiss (still elevated)
    SaveFailed --> Writable: dismiss (was direct save)
```

Notes:

- **Unknown** writability (no permission bits, no probe) collapses into `Writable` — today's
  optimistic behavior. A failed direct save then routes to `SaveFailed`, whose banner offers
  **Retry with sudo** (transition into `Prompting`) when a shell is available.

---

## Read-only detection on open

```mermaid
sequenceDiagram
    participant U as User
    participant FE as FileEditor.tsx
    participant API as api.ts
    participant CMD as commands/files.rs
    participant SFTP as files/sftp.rs (russh-sftp)

    U->>FE: open /etc/nginx/nginx.conf
    par load content
        FE->>API: sftpReadFileContent(session, path)
        API->>CMD: sftp_read_file_content
        CMD->>SFTP: read_file_content()
        SFTP-->>FE: file content
    and probe writability
        FE->>API: sftpCheckWritable(session, path)
        API->>CMD: sftp_check_writable
        CMD->>SFTP: open(path, WRITE) then close
        alt server: PERMISSION_DENIED
            SFTP-->>FE: writable = false
        else open ok
            SFTP-->>FE: writable = true
        else cannot determine
            SFTP-->>FE: writable = unknown
        end
    end

    alt writable = false and shell available
        FE-->>U: Read-only badge + banner + "Edit with sudo"
    else writable = false and SFTP-only
        FE-->>U: Read-only badge + banner + "Save a copy..."
    else
        FE-->>U: normal editor (no badge)
    end
```

---

## Elevated save flow

```mermaid
sequenceDiagram
    participant U as User
    participant FE as FileEditor.tsx
    participant DLG as SudoPromptDialog
    participant API as api.ts
    participant CMD as commands/files.rs
    participant SFTP as files/sftp.rs
    participant SSH as SshSession (exec channel)
    participant H as Remote host

    U->>FE: Save with sudo
    alt no cached password
        FE->>DLG: open prompt (host, user, file)
        DLG-->>FE: password + cache scope
    else cached password
        FE->>FE: use cached password
    end

    FE->>API: sftpWriteFileContentElevated(session, path, content, pw)
    API->>CMD: sftp_write_file_content_elevated
    CMD->>SFTP: write buffer to /tmp/termihub-<uuid>
    SFTP->>H: SFTP create + write_all (temp)
    CMD->>SSH: exec: sudo -S -p '' sh -c 'cat "$TMP" > "$DEST" && rm -f "$TMP"'
    CMD->>SSH: stdin: <password>\n
    SSH->>H: run as root
    alt exit 0
        H-->>FE: ok
        FE->>FE: savedContent = content; keep sudo marker
        opt cache scope = credential store
            FE->>CMD: store SudoPassword credential
        end
        FE-->>U: saved
    else incorrect password
        H-->>FE: error: incorrect password
        FE->>FE: discard cached pw
        FE->>DLG: re-open prompt (retry)
    else other failure
        H-->>FE: error (sudo not permitted / requiretty / write error)
        SSH->>H: rm -f $TMP (cleanup)
        FE-->>U: #969 save-error banner (no retry loop)
    end
```

---

## Sudo prompt + retry / failure

```mermaid
flowchart TD
    Start([Save with sudo]) --> Cached{Cached password?}
    Cached -->|yes| Try[Run elevated save]
    Cached -->|no| Prompt[Show sudo prompt]
    Prompt --> Cancel{Cancel?}
    Cancel -->|yes| Abort([Back to read-only state])
    Cancel -->|no| Try
    Try --> Result{Result}
    Result -->|ok| Done([Saved · sudo marker stays])
    Result -->|incorrect password| Attempts{attempts < 3?}
    Attempts -->|yes| Prompt
    Attempts -->|no| Fail
    Result -->|sudo not permitted / requiretty / write error| Fail[#969 save-error banner]
    Fail --> Abort
```

---

## Capability + cache-scope decision

```mermaid
flowchart LR
    RO{File read-only?} -->|no| Direct[Direct save]
    RO -->|yes| Shell{Shell / exec available?}
    Shell -->|no| Copy[SFTP-only: Save a copy / download]
    Shell -->|yes| Store{Credential store unlocked?}
    Store -->|yes| Choice[Offer: session OR persist]
    Store -->|no| SessionOnly[Session-only cache]
    Choice --> Elevate[Elevated save]
    SessionOnly --> Elevate
```

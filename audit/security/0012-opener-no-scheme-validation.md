---
id: SEC-012
title: External-link opens pass unvalidated URLs to the OS opener (update-server and edited-file content)
angle: security
severity: low
category: security
is_workaround: false
subsystem: src/components, src/services
evidence:
  - src/components/Settings/UpdateSettings.tsx:65
  - src/components/UpdateNotification/UpdateNotification.tsx:46
  - src/components/FileEditor/FileEditor.tsx:1062
status: open
---

## What

The frontend routes external navigation through the Tauri `opener` plugin
(`openUrl`/`openPath`) rather than anchor tags — good — but two paths hand the
opener a URL/scheme that is influenced by semi-remote data with no scheme
allowlist:

1. **Update release URL** — `openUrl(updateInfo.releaseUrl)` at
   `UpdateSettings.tsx:65` and `UpdateNotification.tsx:46`. `releaseUrl` comes from
   the backend `check_for_updates` command, i.e. the remote update/release server;
   no `http(s)`-only check before it reaches the OS opener.
2. **Monaco edited-file content** — `FileEditor.tsx:1062 handleEditorMount` does
   **not** override Monaco's `openerService`/`openLink`, so URLs embedded in file
   content (which is attacker-influenceable when editing a remote/SFTP file) are
   clickable and open through Monaco's default opener.

(The broader frontend was audited and is otherwise clean: no
`dangerouslySetInnerHTML`/`innerHTML`/`eval`, no `WebLinksAddon` on the terminal so
remote terminal output is not turned into clickable links, no markdown/HTML
renderer, and no `target=_blank`/`javascript:` anchor sinks.)

## Why it matters

Passing an unvalidated scheme to the OS opener is a low-severity but real hardening
gap: a compromised/MITM'd update response, or a crafted link inside an edited
remote file, could present a non-`http(s)` scheme (`file:`, a custom
protocol-handler URL, etc.) to the OS handler. Impact is bounded by TLS to the
update server and by the OS handler set, hence low — but for a ventilator-grade
bar, every opener call should enforce `http(s)`.

## Evidence

- `src/components/Settings/UpdateSettings.tsx:65`, `UpdateNotification.tsx:46` —
  `openUrl(updateInfo.releaseUrl)` without scheme validation.
- `src/components/FileEditor/FileEditor.tsx:1062` — no Monaco `openLink` override.
- (Backend-adjacent) `hooks/useSessionFileSystem.ts:250` `openInVscode(entry.path)`
  passes a possibly-remote-session filename to a backend exec command — worth a
  backend-side review of argument handling.

## Recommendation

Add a single `openExternal(url)` helper that parses the URL and refuses anything
but `http:`/`https:` (and `mailto:` if wanted) before calling `openUrl`; route all
opener call sites through it. Register a Monaco `openLink`/opener override in
`handleEditorMount` that runs links through the same validated helper. Verify the
`openInVscode` backend command treats the path strictly as an argv element (not a
shell string).

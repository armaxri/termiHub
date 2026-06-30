# Sync Ledger — Elevated SFTP Editing

**Last synced:** `6e5d9586` (base develop commit at concept creation)
**Status:** concept only — not yet implemented

This ledger is maintained by the `/sync-concept elevated-sftp-editing` skill. It records the last
commit at which the concept artifacts and the code were reconciled, plus any open divergences. The
concept is the source of truth; code is fixed to match by default.

## Open divergences

| #   | Artifact claim                                                          | Code reality                                                        | Type    | Recommendation                              |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------- | ------- | ------------------------------------------- |
| 1   | Early read-only detection (probe + `FileEntry.writable`, badge, banner) | Not implemented — save failure is only surfaced at save time (#969) | Missing | Implement per `concept.md` §1, then re-sync |
| 2   | Elevated (sudo) save via exec channel + temp upload                     | Not implemented — only direct SFTP `create`/`write_all`             | Missing | Implement per `concept.md` §2, then re-sync |
| 3   | `CredentialType::SudoPassword` for opt-in persistence                   | Only `Password` and `KeyPassphrase` exist                           | Missing | Implement per `concept.md` §3, then re-sync |
| 4   | `SudoPromptDialog` component                                            | No such component                                                   | Missing | Build alongside the elevated-save UI        |

## Notes / known constraints

- `russh-sftp` (v2.3) exposes permission bits but **no uid/gid**, so writability detection relies
  on permission bits plus a best-effort SFTP write-open probe rather than true ownership. The
  concept already accounts for this (`writable: Option<bool>` with an `unknown` state).
- The mockups add proposed BEM classes (`.file-editor__readonly-badge`, `.file-editor__elevate-btn`,
  `.file-editor__elevated-mark`, `.file-editor__readonly-banner`) inline; when implemented these
  should be moved into `src/components/FileEditor/FileEditor.css` and mirrored back into
  `docs/concepts/_assets/mockup.css`.

## Resolved

| Date | #   | Resolution |
| ---- | --- | ---------- |
| —    | —   | —          |

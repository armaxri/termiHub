---
id: I18N2-001
title: "Elevated (sudo) save classifies wrong password by English sudo stderr with no C locale, so a stale stored sudo password is never cleared"
angle: i18n
severity: medium
category: locale-dependent-classification
is_workaround: false
subsystem: "core/backends/ssh elevated write + FileEditor"
evidence:
  - core/src/backends/ssh/sftp_ops.rs:145
  - core/src/backends/ssh/sftp_ops.rs:182
  - core/src/backends/ssh/sftp_ops.rs:201
  - core/src/backends/ssh/sftp_ops.rs:206
  - src/components/FileEditor/FileEditor.tsx:1143
  - src/components/FileEditor/FileEditor.tsx:1178
  - src/components/FileEditor/FileEditor.tsx:1236
status: fixed
resolution: "#4290 — sudo runs under LC_ALL=C with a unique -p prompt; wrong password is classified from the prompt count, exit status and an authorization marker, not translated text"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

`classify_sudo_result` maps a failed elevated save to `IncorrectPassword` only
when lower-cased stderr contains English text: "sorry, try again", "incorrect
password", "no password was provided" or "password is required"
(SUDO_PASSWORD_MARKERS). The command `sudo -S -p '' /bin/sh -c ...` runs with no
`LC_ALL=C`/`LANG=C`, and sudo and PAM translate these messages with gettext
under the remote user's locale. A German host prints "Entschuldigung, versuchen
Sie es noch einmal."; French and Spanish hosts print their own translations.
Every wrong password on a non-English host is therefore classified as
`Other(message)`. The I18N-005 fix pinned the C locale on monitoring, process
and Docker commands but missed this exec path.

## Why it matters

FileEditor routes `Other` to the "error" outcome. (1) If the saved sudo password
is stale, `saveElevated` returns "failed" at FileEditor.tsx:1178 before it
reaches the discard-and-prompt branch. The stale credential is never removed and
the user is never prompted, so every save fails with a localized "Save failed:
..." banner until they find and delete the credential by hand in Settings. This
is the same class as I18N-001 (a credential lifecycle gated on English text).
(2) A mistyped password in the interactive prompt dismisses the dialog with an
error instead of re-prompting (FileEditor.tsx:1236). Elevated save is a core
remote-editing flow, and admins of non-English servers are a common case.

## Evidence

- `core/src/backends/ssh/sftp_ops.rs:145`
- `core/src/backends/ssh/sftp_ops.rs:182`
- `core/src/backends/ssh/sftp_ops.rs:201`
- `core/src/backends/ssh/sftp_ops.rs:206`
- `src/components/FileEditor/FileEditor.tsx:1143`
- `src/components/FileEditor/FileEditor.tsx:1178`
- `src/components/FileEditor/FileEditor.tsx:1236`

## Recommendation

Pin the locale for sudo's own process: build the command as `env LC_ALL=C LANG=C
LANGUAGE= sudo -S -p '' /bin/sh -c '...' sh <temp> <dest>`, or prefix `export
LC_ALL=C LANG=C;` as the monitoring commands do. sudo reads its message locale
from its own environment, and LC_ALL=C also makes gettext ignore LANGUAGE.
Update the `build_sudo_write_command` test at sftp_ops.rs:385 to assert the
prefix. Add a classifier test with localized stderr to document that the
C-locale prefix is what keeps classification correct. As defence in depth,
consider recognizing sudo's exit status together with an empty-stdout/no-write
signal. Do not add more translated marker strings.

## Verification

The code confirms it. In sftp_ops.rs, build_sudo_write_command emits `sudo -S -p
'' /bin/sh -c ...` with no LC_ALL/LANG prefix, and nothing in
core/src/backends/ssh sets LC_ALL. classify_sudo_result matches only the English
SUDO_PASSWORD_MARKERS ("sorry, try again", "incorrect password", and so on). Any
other non-zero exit becomes Other(msg). sudo's messages are gettext-translated.
On a Debian or Ubuntu host the remote locale typically comes from
/etc/default/locale via pam_env, so a German or French server produces
translated stderr and the result is Other. In FileEditor.tsx,
attemptElevatedWrite maps Other to "error" (around line 1144). saveElevated then
returns "failed" at `if (outcome === "error") return "failed"` before it reaches
the removeCredential/prompt branch, so a stale stored sudo password is never
discarded and no prompt opens. In handleSudoSubmit, "error" dismisses the dialog
instead of re-prompting. I found no guard elsewhere, and no ADR or audit entry
accepts this. I18N-005 covers parsed monitoring commands but not this exec path.
I downgraded it from high to medium. It does not delete or corrupt data, and it
does not wrongly delete a valid credential, which is the opposite and worse
direction of I18N-001. It only shows on non-English-locale hosts. The user gets
a visible "Save failed" banner with the localized sudo text and can recover by
removing the stored credential in Settings or retrying. This is a real usability
and robustness defect in a core flow, not a safety or data-loss issue.

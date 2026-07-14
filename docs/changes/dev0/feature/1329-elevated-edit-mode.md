### Added

- **Elevated (sudo) edit mode** in the file editor: a read-only remote file on an
  exec-capable (SSH shell) connection now shows an **Edit with sudo** action in
  place of Save. Authorizing opens a password prompt that names the host, user,
  and target file, masks the password, and offers **Remember for this session**
  (default on) plus **Save in credential store** (shown only when the credential
  store is unlocked). A correct password writes the file with root privileges via
  the elevated backend path, confirms with a success toast, and pins a persistent
  accent **sudo** marker in the toolbar for the rest of the session — subsequent
  saves reuse the cached (or stored) password without re-prompting. A wrong
  password re-prompts with an attempt counter up to three times, then falls back
  to the existing save-error banner with the edited buffer preserved; a
  non-password failure (sudo missing / not in sudoers) surfaces the same banner.
  The banner also gains a **Retry with sudo** action for a direct save that failed
  on an unknown-writability file. The sudo password lives only in in-memory
  session state and, opt-in, the credential store — it is never written to tab or
  workspace state, and never logged. (#1329, epic #1323, concept #970)

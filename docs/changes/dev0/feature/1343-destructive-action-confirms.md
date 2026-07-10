### Added

- Destructive, session-killing actions now confirm and/or offer an undo instead
  of firing on a single unguarded click (#1343):
  - **Close a tab with a live session**: the tab X and middle-click now warn
    before ending a live SSH/serial/local/telnet session (previously only the
    keyboard close path confirmed). The dialog offers a "Don't ask again"
    opt-out (re-enable it under Settings → General → "Confirm Closing a Live
    Session"), and after closing, a toast offers **Reopen** to reconnect the
    connection. Tabs attached to a persistent session (which only detach) and
    already-exited tabs close without a prompt.
  - **Close a split panel**: closing a panel that holds live sessions now shows
    a count-aware confirmation ("Closing this panel will close N tabs and end M
    live sessions") before tearing them all down.
  - **Delete a connection**: single and bulk deletes now always confirm
    (previously only the jump-host-dependent case did); the existing jump-host
    warning is appended to the confirmation when a target is still referenced.
  - **Open Connections panel**: every section "Kill All" and the agent
    "Shutdown" now confirm before the bulk teardown on the app's canonical
    kill surface.

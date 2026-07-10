### Changed

- Several mutating actions that previously failed silently now give clear
  success/error feedback (#1342):
  - **Embedded servers**: saving, duplicating, and copying a server's URL now
    show a success toast, and failures surface a recoverable error toast instead
    of only logging to the (user-inaccessible) console. The create/edit dialog
    now stays open when a save fails so you can fix the problem and retry.
  - **SSH tunnels**: duplicating a tunnel now confirms with a toast and reports
    failures, instead of silently logging errors.
  - **Connection editor**: saving a connection confirms with a toast, and a
    failed remote agent-definition save now reports the error instead of failing
    silently.
  - **Settings**: General/Appearance/Terminal settings auto-save, so the panel
    now shows a subtle "Saved" acknowledgment after each change and no longer
    prompts with a contradictory "unsaved changes" dialog when the tab is closed.

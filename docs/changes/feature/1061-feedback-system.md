## Added

- **App-wide toast notifications.** Actions that previously resolved silently now give immediate feedback: saving/deleting a connection, creating/renaming a folder, starting/stopping a tunnel, unlocking the credential store, and deploying an agent all show a success or failure toast (long-running ones show a live "in progress" toast that resolves in place).
- **Async action buttons** now show a spinner and disable themselves while the action runs, then confirm success or surface a recoverable error — preventing accidental double-submits.

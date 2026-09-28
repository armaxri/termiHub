### Fixed

- Agent setup: the **Deploy Agent** dialog now follows the deploy's live progress
  and closes with a success or failure toast when the deploy finishes. It used
  to stay on "Setup started…" because it read the progress event's agent id
  under a field name the backend never sent (#3088).

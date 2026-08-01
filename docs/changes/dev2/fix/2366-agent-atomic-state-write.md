### Fixed

- Agent: the remote agent now writes its `state.json` (session-recovery state) and `connections.json` (saved connections) atomically, so a crash, power loss, or full disk mid-write can no longer truncate these files and silently wipe persisted sessions or saved connections on restart (#2366).

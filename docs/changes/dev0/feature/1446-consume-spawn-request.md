### Added

- Shell context-menu / CLI container spawns now open a session. When an external
  `termiHub spawn --location <dir> --container-image <image>` reaches the running
  instance, termiHub resolves the Docker settings and opens a Docker terminal tab
  with the target directory bind-mounted (working directory set to the mount).
  The tab shows a **"Spawned"** badge, a confirmation toast reports the opened
  container, and the spawned container is tracked in its own **Spawned
  Containers** section of the Open Connections panel — separate from configured
  Docker connections (spawned containers have no saved connection id) and no
  longer double-listed under Local Sessions (#1446, epic #1363).

  Non-container spawns (local / WSL / SSH) are handled by a follow-up work item
  (SI-2) and are ignored for now.

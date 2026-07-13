### Changed

- Open Connections — spawned containers now stay grouped under **Spawned
  Containers** even after their tab is closed. The spawned origin is recorded on
  the backend session registry (not only on the frontend tab), so a spawned
  container whose tab was closed but whose backend session leaked (an orphan) no
  longer silently falls back into **Local Sessions** — it remains visible under
  Spawned Containers and killable, which is exactly the orphan case the panel
  exists to surface. (#1466, follow-up to #1446, epic #1363)

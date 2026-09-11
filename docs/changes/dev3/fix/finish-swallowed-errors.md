### Fixed

- Background failures that were previously swallowed silently are now auditable
  in the LogViewer instead of vanishing. A failed stale-credential removal during
  an auth-failure retry now surfaces an error (WA-FE-005), and bulk window /
  workspace session teardown logs any session that failed to detach or close
  (so a leaked session is visible rather than hidden) (UX-033, FEC-009).
- Genuinely best-effort background operations (terminal/file-browser/remote-desktop
  session cleanup, in-flight connect aborts, network-task cancels, temp-file
  cleanup, "open in browser", fullscreen toggles, advisory window-ownership, and
  capability probes) now log any failure to the LogViewer via a shared
  `fireAndForget` helper, so a background failure is always traceable and never an
  untraceable empty `.catch`.

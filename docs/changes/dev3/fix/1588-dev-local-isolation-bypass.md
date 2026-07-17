### Fixed

- `pnpm tauri dev` now starts on the Vite dev port from this checkout's
  `dev.local.json` (`dev_port`) instead of always binding the default `1420`.
  Only `./scripts/dev.sh` / `scripts/dev.cmd` read the file before, so launching
  the app directly silently squatted on checkout 0's dev server and dev agent —
  a collision that surfaced as cross-checkout flakiness rather than a clean
  error. Both halves of the launch now resolve the port from the same place:
  `vite.config.ts` (which binds it) and Tauri's `build.devUrl` (which loads it,
  via the new `pnpm tauri` wrapper). A checkout with no `dev.local.json` — a
  fresh clone, or CI — still uses `1420`, and `TERMIHUB_DEV_PORT` still
  overrides both (#1588).

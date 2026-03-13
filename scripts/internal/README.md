# scripts/internal

Internal helper scripts used by other scripts or tooling. These are **not** intended for direct use by developers.

| File            | Used by                                  | Purpose                                             |
| --------------- | ---------------------------------------- | --------------------------------------------------- |
| `autoformat.sh` | `.claude/settings.json` PostToolUse hook | Auto-format a single file (Prettier / rustfmt)      |
| `kill-port.cjs` | `dev.sh` / `dev.cmd`                     | Kill any process occupying the Vite dev server port |

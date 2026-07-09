# scripts/internal

Internal helper scripts used by other scripts or tooling. These are **not** intended for direct use by developers.

| File                       | Used by                                  | Purpose                                                                                                                      |
| -------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `autoformat.sh`            | `.claude/settings.json` PostToolUse hook | Auto-format a single edited file (Prettier / rustfmt) and refresh the `data-testid` catalog when a source `.tsx` changes     |
| `regen-testid-catalog.mjs` | `autoformat.sh`                          | Regenerate `tests/system/testid-catalog.md` when the edited file is a source `.ts`/`.tsx` containing a `data-testid` (#1084) |
| `kill-port.cjs`            | `dev.sh` / `dev.cmd`                     | Kill any process occupying the Vite dev server port                                                                          |
| `package-vcxsrv.ps1`       | release process (operator, Windows)      | Build the pinned minimal VcXsrv `.zip` for SSH X11 forwarding from an installed VcXsrv, print/patch its SHA-256 (#1076)      |
| `package-vcxsrv.sh`        | `package-vcxsrv.ps1`                     | Git-Bash wrapper that forwards long flags to `package-vcxsrv.ps1`                                                            |

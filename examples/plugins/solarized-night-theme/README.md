# Solarized Night — example theme plugin

A minimal, **JSON-only** termiHub plugin. It bundles a single dark color theme
and declares no native code, so it exercises the whole plugin lifecycle —
package → install → enable → theme registration — with **zero native-loading
risk**. Use it as the starting point for any theme-only plugin.

## Layout

```text
solarized-night-theme/
├── manifest.json               # plugin identity + the `theme` extension point
├── themes/
│   └── solarized-night.json    # a termiHub theme file (schema: termihub-theme-v1)
└── README.md                   # this file
```

## What makes it a theme plugin

- The manifest declares a single `theme` extension whose `themes[]` entry points
  at `solarized-night.json` (resolved inside the package's `themes/` directory).
- `permissions` is **empty**: a theme changes colors only, so it requests no
  capabilities. Keep permissions to the minimum a plugin actually needs.
- There is no `backend/` directory and no `terminalBackend` extension, so nothing
  native is ever loaded.

## Packaging

From the repository root:

```bash
./scripts/package-plugin.sh examples/plugins/solarized-night-theme --out dist
```

That produces `dist/solarized-night-1.0.0.termihub-plugin`, a ZIP validated
against the same checks the host applies on install.

See [`docs/plugin-authoring.md`](../../../docs/plugin-authoring.md) for the full
manifest schema, the theme-file format, and the extension-point reference.

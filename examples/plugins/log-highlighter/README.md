# Log Highlighter — example protocol-parser plugin

A minimal **JavaScript protocol-parser** plugin. It colors the log levels
`ERROR` (red) and `WARN` (yellow) in terminal output by wrapping them in ANSI
color escapes. Use it as the starting point for any output filter.

## Layout

```text
log-highlighter/
├── manifest.json       # plugin identity + the `protocolParser` extension point
├── frontend/
│   └── index.js        # the parser — runs in the frontend-plugin sandbox
└── README.md           # this file
```

## How it works

- The manifest declares a `protocolParser` whose `entryPoint` is
  `frontend/index.js` (a path inside the package).
- The script calls `termihub.registerProtocolParser({ id, name, transform })`.
  `termihub` is this plugin's own API instance, injected by the host.
- `transform(data, sessionId)` runs for every output chunk. It returns the
  rewritten text, or `null` to leave the chunk byte-exact — the fast path most
  chunks should take.
- The code runs in a **sandboxed Web Worker**: no DOM, no `window`, no Tauri
  IPC, no access to the app. A throwing `transform` is logged and skipped; it
  never breaks the terminal.
- `permissions` is `["terminal"]`: the plugin only touches terminal output.

Output arrives in arbitrary chunks, so a token split across two chunks is not
highlighted. A parser that must never miss a match has to buffer per
`sessionId` (the optional `onSessionStart` / `onSessionEnd` hooks mark session
boundaries).

## Trying it

JavaScript plugins are **experimental and off by default**. Package it, install
it from **Plugins → Install from file…**, then turn on
**Settings → Plugins → Frontend Plugins (Experimental)**. Run
`echo "ERROR disk full; WARN low memory"` in a terminal to see it.

## Packaging

From the repository root:

```bash
./scripts/package-plugin.sh examples/plugins/log-highlighter --out dist --no-build
```

That produces `dist/log-highlighter-1.0.0.termihub-plugin`, validated against
the same checks the host applies on install. The sandbox behaviour is covered
by `src/plugins/examplePlugins.test.ts`.

See [`docs/plugin-authoring.md`](../../../docs/plugin-authoring.md) for the full
manifest schema and the extension-point reference.

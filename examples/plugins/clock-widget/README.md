# Clock Widget — example status-bar-widget plugin

A minimal **JavaScript status-bar-widget** plugin. It shows the local time
(`HH:MM`) on the right of the status bar and refreshes it every 30 seconds.
Use it as the starting point for any status-bar widget.

## Layout

```text
clock-widget/
├── manifest.json       # plugin identity + the `statusBarWidget` extension point
├── frontend/
│   └── index.js        # the widget — runs in the frontend-plugin sandbox
└── README.md           # this file
```

## How it works

- The manifest declares a `statusBarWidget` with `entryPoint`
  `frontend/index.js` and `position` `right`.
- The script calls `termihub.registerStatusBarWidget(widget)` with a widget of
  `id`, `position`, `render` and `dispose`. `termihub` is this plugin's own API
  instance, injected by the host.
- The code runs in a **sandboxed Web Worker** with no DOM, so `render()` returns
  a small declarative node — `{ tag: "span", text, attrs }` — which the host
  builds into the status bar through a strict allowlist: inert tags only, text
  set via `textContent`, no event handlers, no URLs, no raw HTML.
- To change what is shown, register the widget again under the same `id`; the
  host replaces the previous node.
- `dispose()` runs when the plugin is disabled or uninstalled. It stops the
  timer — always release timers and other resources there.
- `permissions` is `["ui"]`: the plugin only renders into a UI slot.

## Trying it

JavaScript plugins are **experimental and off by default**. Package it, install
it from **Plugins → Install from file…**, then turn on
**Settings → Plugins → Frontend Plugins (Experimental)**. The time appears on
the right of the status bar.

## Packaging

From the repository root:

```bash
./scripts/package-plugin.sh examples/plugins/clock-widget --out dist --no-build
```

That produces `dist/clock-widget-1.0.0.termihub-plugin`, validated against the
same checks the host applies on install. The sandbox behaviour is covered by
`src/plugins/examplePlugins.test.ts`.

See [`docs/plugin-authoring.md`](../../../docs/plugin-authoring.md) for the full
manifest schema and the extension-point reference.

# Echo Backend — example native plugin

A minimal termiHub **native terminal-backend** plugin. Every byte written to the
session is echoed back to the host's output channel, optionally with a
configurable prefix. It is the reference for the stable-ABI entry points defined
by the [`termihub-plugin-api`](../../../plugin-api) crate — not a production
backend.

## Layout

```text
echo-backend/
├── Cargo.toml       # cdylib crate depending on termihub-plugin-api
├── src/lib.rs       # the four extern "C" entry points + PluginTerminalBackend impl
├── manifest.json    # plugin identity + the `terminalBackend` extension point
└── README.md        # this file
```

## The four exported symbols

| Symbol | Purpose |
| --- | --- |
| `termihub_plugin_abi_version` | ABI version this plugin was built against |
| `termihub_plugin_init` | fills in the plugin's `PluginInfo` metadata |
| `termihub_plugin_create_backend` | builds a session backend from JSON config |
| `termihub_plugin_shutdown` | process-wide cleanup before unload |

## Building and packaging

The `package-plugin` script builds the `cdylib`, stages the compiled library into
`backend/`, and zips a validated `.termihub-plugin`:

```bash
./scripts/package-plugin.sh examples/plugins/echo-backend --out dist
```

That produces `dist/echo-backend-1.0.0.termihub-plugin` containing
`backend/libecho_backend.{so,dylib}` (or `backend/echo_backend.dll` on Windows).

> **ABI caveat.** Rust has **no stable ABI**, so a native plugin must be built
> against the **same major ABI version** of `termihub-plugin-api` that the target
> host ships, with a compatible toolchain — the host refuses to load a mismatch
> (`termihub_plugin_abi_version`). Cross-platform dynamic-library building is the
> author's responsibility; a package built on one OS only carries that OS's
> library. Because of this, native-plugin **packaging** is not built for every
> platform in CI — but the crate itself compiles on all platforms via the
> workspace build, and its behavior is covered by unit tests (`cargo test -p
> echo-backend`).

See [`docs/plugin-authoring.md`](../../../docs/plugin-authoring.md) for the full
ABI reference and manifest schema.

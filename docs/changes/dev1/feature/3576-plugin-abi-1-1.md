## Added

- Native plugin ABI 1.1: native terminal-backend plugins now receive a host context — the termiHub version, a private data directory, a logging channel whose messages appear in the Log Viewer (tagged with the plugin's id), and a cancellation signal when a session closes or the plugin is disabled.
- `package-plugin` prints the Rust toolchain a native backend is built with, warns when it differs from the one termiHub releases use, and accepts `--toolchain <version|release>`.

## Changed

- termiHub now refuses a native plugin that was built with a different Rust compiler or panic strategy than termiHub itself, with a message naming both. Plugins built for ABI 1.0, which cannot report their compiler, load only after you explicitly accept the unverified toolchain when trusting them in Settings → Plugins → Native Plugins.

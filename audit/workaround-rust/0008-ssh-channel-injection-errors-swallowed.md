---
id: WA-RS-008
title: SSH env/DISPLAY/xauth injection and WSL stdin writes swallow errors silently
angle: workaround-rust
severity: medium
category: reliability
is_workaround: true
subsystem: core/backends/ssh, core/backends/wsl
evidence:
  - core/src/backends/ssh/connector.rs:282
  - core/src/backends/ssh/connector.rs:288
  - core/src/backends/ssh/connector.rs:293
  - core/src/backends/wsl.rs:465
  - core/src/backends/wsl.rs:466
status: fixed
resolution: "#2763 — ssh env/x11/wsl errors logged (secret-safe)"
---

## What
After the SSH shell starts, the connector injects the user's `export` env line,
`export DISPLAY=...`, and `xauth add ...` by writing to the channel with the
result discarded and **not even logged**:

```rust
if let Some(export_line) = super::build_ssh_env_export(&config.env) {
    let _ = channel.data(export_line.as_bytes()).await;
}
if let Some(display_num) = x11_display {
    let export_cmd = format!("export DISPLAY=localhost:{display_num}.0\n");
    let _ = channel.data(export_cmd.as_bytes()).await;
    if let Some(ref cookie) = x11_cookie {
        let xauth_cmd = format!("xauth add localhost:{display_num} MIT-MAGIC-COOKIE-1 {cookie} 2>/dev/null\n");
        let _ = channel.data(xauth_cmd.as_bytes()).await;
    }
}
```

The WSL backend similarly does `let _ = w.write_all(data); let _ = w.flush();`
on process stdin.

## Why it matters
If the channel write fails, the user's environment variables, `DISPLAY`, or the
X11 xauth cookie silently never take effect — X11 forwarding or configured env
vars break with **no diagnostic** anywhere. This is the concerning subset of a
broader `let _ = ...` pattern (~389 sites total; most are legitimate best-effort
channel sends / cleanup on drop, but these mutate user-visible session state).
For WSL, dropped stdin writes silently lose user input.

## Why the rest are (mostly) fine
The majority of `let _ = ...` sites are best-effort teardown (`stream.quit()`,
`client.close()`, `remove_dir_all(staging)`) or channel sends whose receiver has
gone — intentional and correct. This finding targets only the state-mutating
writes that fail invisibly.

## Recommendation
At minimum `warn!`/`debug!` on write failure for the SSH env/DISPLAY/xauth
injections and WSL stdin writes so a broken forwarding/env is diagnosable. Better:
propagate a soft warning to the session (a toast / status line) when X11 or env
injection cannot be delivered, since the user explicitly requested them.

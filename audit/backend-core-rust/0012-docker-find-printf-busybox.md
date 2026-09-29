---
id: CORE-012
title: Docker file listing uses GNU-only `find -printf`, breaking on BusyBox/Alpine images
angle: backend-core-rust
severity: medium
category: bug
is_workaround: false
subsystem: core/backends/docker
evidence:
  - core/src/backends/docker/file_browser.rs:178
status: fixed
resolution: "#2800 — docker dir listing portable (POSIX sh + stat/readlink) — busybox/alpine safe"
---

## What
Directory listing runs `find … -printf`:

```rust
vec![
    "find", path, "-maxdepth", "1", "-not", "-name", ".",
    "-not", "-path", path, "-printf",
    "%f\t%y\t%s\t%T@\t%m\t%Y\t%l\n",
],
```

## Why it matters
`-printf` is a GNU findutils extension. BusyBox `find` — the `find` in Alpine and
most minimal container images — does not implement it, so the exec fails and file
browsing returns an error on exactly the most common container base images.
`alpine` is even the connection schema's own placeholder/example image.

## Evidence
`core/src/backends/docker/file_browser.rs:178-201`.

## Recommendation
Fall back to a portable listing when `-printf` is unsupported (parse `ls -la`, or
`stat` per entry), or detect BusyBox and branch. Do not assume GNU coreutils in
containers.

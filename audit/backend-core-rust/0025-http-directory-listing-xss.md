---
id: CORE-025
title: Embedded HTTP directory listing interpolates filenames without escaping (stored XSS)
angle: backend-core-rust
severity: medium
category: security
is_workaround: false
subsystem: core/embedded_servers/http
evidence:
  - core/src/embedded_servers/http_server.rs:89
status: in-progress
resolution: "#2728"
---

## What
The auto-generated directory listing builds `<a>` links by string-formatting the
raw filename into HTML with no escaping:

```rust
for (is_dir, name) in names {
    let suffix = if is_dir { "/" } else { "" };
    items.push(format!(
        r#"<li><a href="{name}{suffix}">{name}{suffix}</a></li>"#
    ));
}
```

## Why it matters
A filename containing HTML/JS (e.g. `"><img src=x onerror=alert(1)>` — a legal
filename on Unix) is served verbatim into the listing page. Anyone browsing the
shared directory over the embedded HTTP server executes the injected script in
their browser (stored XSS), and the `href` is likewise unescaped/allows attribute
breakout. The server is meant to share arbitrary local directories, so the
attacker-controlled filename is a realistic vector.

## Evidence
`core/src/embedded_servers/http_server.rs:89-94`.

## Recommendation
HTML-escape the filename for the link text and URL-encode it for the `href`
(percent-encode the path segment). Prefer a small escaping helper over raw
`format!`.

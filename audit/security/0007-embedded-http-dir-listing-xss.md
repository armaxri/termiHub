---
id: SEC-007
title: Embedded HTTP server directory listing injects filenames and URL path into HTML unescaped (stored/reflected XSS)
angle: security
severity: high
category: security
is_workaround: false
subsystem: core/src/embedded_servers
evidence:
  - core/src/embedded_servers/http_server.rs:92
  - core/src/embedded_servers/http_server.rs:100
  - core/src/embedded_servers/http_server.rs:102
  - core/src/embedded_servers/http_server.rs:77
status: in-progress
resolution: "#2728 — CI failed; fixer pending"
---

## What

The embedded HTTP server's auto-generated directory index interpolates
directory-entry filenames and the request URL path **raw** into the HTML
response, with no HTML-entity escaping:

```rust
// core/src/embedded_servers/http_server.rs:89-93
for (is_dir, name) in names {          // name = e.file_name() (line 77)
    let suffix = if is_dir { "/" } else { "" };
    items.push(format!(
        r#"<li><a href="{name}{suffix}">{name}{suffix}</a></li>"#  // unescaped href + text
    ));
}
```
```rust
// core/src/embedded_servers/http_server.rs:100,102
r#"...<title>Index of {url_path}</title>...<h1>Index of {url_path}</h1>..."#  // reflected
```

A filename such as `"><img src=x onerror=alert(document.cookie)>` (or an
`href`-breaking `"><script>…`) is emitted verbatim into both the `href`
attribute and the anchor text; the request path is reflected into `<title>`/`<h1>`.
This same generator backs both the desktop embedded server and the **agent-hosted**
HTTP server.

## Why it matters

Whoever can place a file in a served directory — a remote SSH/SFTP peer, another
user on the agent host, a Docker container, or an attacker who dropped a file via
any other channel — controls script that runs in the browser of anyone who opens
the directory index. In the threat model (malicious remote host/agent, hostile
files), this is stored XSS delivered by the app's own server. The reflected
`url_path` variant additionally lets a crafted link execute script in a victim's
browser. Consequences depend on where the page is viewed, but include cookie/token
theft for anything sharing the origin, and it is a poor look for a device that
also serves files to clinical browsers. `SECURITY.md` explicitly lists "leaking
sensitive data through … the embedded servers" as in-scope.

## Evidence

- `core/src/embedded_servers/http_server.rs:77` — `name` from `e.file_name()`.
- `:92` — filename interpolated into `href` and link text with no escaping.
- `:100`, `:102` — `url_path` reflected into `<title>`/`<h1>`.
- No `html_escape` / `ammonia` / percent-encoding in the function; only a
  path-traversal check exists elsewhere (`:132`), which does not address output
  encoding.

## Recommendation

HTML-escape every interpolated value: entity-encode `& < > " '` in `name` and
`url_path` for the text/attribute contexts, and percent-encode `name` for the
`href` URL context (they are different encodings — do both). Prefer a small,
maintained helper (`askama`/`maud` templating with auto-escaping, or the
`html-escape`/`percent-encoding` crates) over hand-rolled `format!`. Add a
regression test that serves a directory containing a file named
`"><img src=x onerror=…>` and asserts the response contains the escaped form and
no live tag. Apply the same to the agent-hosted server path.

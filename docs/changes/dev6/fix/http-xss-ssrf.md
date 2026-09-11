### Security

- The embedded HTTP server's directory-listing page now HTML-escapes filenames
  and the reflected request path, closing a stored/reflected XSS where a hostile
  filename (e.g. `"><img src=x onerror=…>`, a legal name on Unix) or a crafted
  URL could inject script into the browser of anyone viewing the index. This
  server can also be agent-hosted, so the fix protects both surfaces
  (SEC-007 / CORE-025).
- The HTTP monitor now blocks requests to internal targets by default (SSRF
  protection, SEC-008). It refuses loopback, RFC 1918 private, IPv6 unique-local,
  link-local (including the cloud-metadata endpoint `169.254.169.254`), and the
  unspecified address — validating the exact address it connects to, and every
  redirect hop, so a hostname cannot rebind to an internal IP. Link-local and the
  unspecified address are always blocked. Monitoring a legitimately internal host
  (e.g. a local dev server on `localhost`) is available via the new
  "Allow internal / private targets" toggle, which defaults to off.

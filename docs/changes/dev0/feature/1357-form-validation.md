### Fixed

- Form validation is now enforced, not just cosmetic: invalid input is flagged
  inline at the field and blocks the action instead of saving a broken config
  that fails later at connect/run time (#1357).
  - **Connection editor**: Save and Save & Connect are gated on a valid form —
    the schema-driven form reports overall validity and a per-field error map
    upward, and attempting to save while invalid flags the Connection tab and
    scrolls to and focuses the first invalid field. Required fields now render a
    marker and `aria-required`. A field hidden by a `visibleWhen` rule never
    blocks Save.
  - **SSH tunnel editor**: ports are validated to 1–65535 and hosts must be
    non-empty, with inline errors; Save/Save & Start are disabled while invalid
    (previously `parseInt(...) || 0` let port 0, a blank host, or a port above
    65535 save).
  - **Network tools**: Ping (interval/count), Traceroute (max hops), Port
    Scanner (timeout/concurrency) and Wake-on-LAN (port) numeric fields are
    range-checked inline and disable Run/Start/Send while invalid.
  - **HTTP Monitor**: the URL is validated with a real scheme + host check
    (replacing the brittle `url === "https://"` guard), so a real URL can be
    entered from an empty field and an incomplete URL is flagged inline.

### Security

- Upgraded the `ringbuf` dependency (output ring buffer used by serial capture
  and daemon PTY replay) from 0.5.0 to 0.5.2 to pull in the fix for
  RUSTSEC-2026-0293 — a double-free / use-after-free in `Consumer::skip` and
  `Consumer::clear` that could trigger if an element's `Drop` panics. termiHub's
  buffer stores plain bytes (whose `Drop` cannot panic), so the app was not
  exploitable in practice, but the crate is now on the patched release.

### Changed

- **Native plugins are now default-OFF and require explicit per-plugin trust.**
  A native (in-process) plugin backend is a dynamic library loaded inside
  termiHub with the app's full privileges and no operating-system sandbox.
  Previously such a plugin loaded automatically once installed and enabled. Now
  it loads only when **both** hold: native plugins are turned on globally
  (Settings → Plugins → "Enable Native (In-Process) Plugins", off by default),
  **and** that specific plugin has been individually trusted. The trust
  acknowledgment is bound to a content hash of the exact library, so a changed or
  swapped binary is no longer trusted and must be re-acknowledged. Every check
  fails closed — a missing setting, a missing or stale acknowledgment, or an
  unreadable library refuses the load. Turning the global switch off, or revoking
  a plugin's trust, unloads native plugins immediately. The trust surface states
  plainly that native plugins run in-process with full privileges and no sandbox.
  Sandboxed JavaScript and theme plugins are a separate surface and are
  unaffected (SEC-002 / PLG-006 / ARCH-008).

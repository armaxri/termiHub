### Changed

- Settings are reorganized so each domain is discoverable from the navigation.
  The overloaded **General** category — which mixed SSH/shell defaults, serial
  port scanning, close/warn prompts, session restore + history, the experimental
  flag, and X server provisioning — is split into dedicated categories: **Serial**
  (serial port scan prefixes), **Sessions** (startup restore + Recent Sessions
  history), **Safety Prompts** (close confirmations and large port-scan / ping-sweep
  warnings), and **X Server** (automatic X server provisioning). **General** now
  holds only connection/shell defaults and the experimental-features flag. Every
  setting keeps its value and behavior; search still finds each one and jumps to
  its new category (UX-029).
- The three near-identical "close" confirmation toggles now have precise,
  differentiated labels — "Confirm before closing a tab via keyboard shortcut",
  "Confirm before closing a tab with a live session", and "Show a one-time notice
  when closing a persistent-session tab" (the last no longer implies a per-close
  confirmation it never performed) — and are grouped under a **Close confirmations**
  sub-header (UX-030).

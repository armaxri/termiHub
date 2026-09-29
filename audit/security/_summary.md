---
angle: security
expert: Application security
date: 2026-09-10
findings: 13
critical: 0
high: 5
medium: 4
low: 3
---

# Security audit — summary

Pre-release ("ventilator-grade") security review of termiHub across credential/secret
handling, connection security, the plugin system, the IPC/command surface, Tauri
hardening, web/XSS, and the app↔agent transport. Threat model per brief: malicious
remote hosts/agents, malicious plugins, local malware, MITM, and hostile
config/workspace files.

## Overall posture

**Mixed, but fixable — no cryptographic own-goals, several real exposure gaps.**
The cryptographic core is genuinely strong and the historically-dangerous paths have
already been hardened. What remains are exposure/containment gaps that are
individually fixable but, taken together, sit above the bar a safety-critical
release should clear. **No criticals**, but **5 highs**, of which the two most
release-relevant are the in-process native-plugin trust model (SEC-002) and the
unauthenticated agent TCP transport (SEC-004), plus three concrete
attacker-reachable bugs (password env-expansion SEC-001, embedded-server XSS
SEC-007, HTTP-monitor SSRF SEC-008).

### What is done well (verified, not findings)

- **Credential encryption** (`credential/crypto.rs`, `master_password.rs`):
  Argon2id (64 MiB / t=3) + AES-256-GCM, per-record KDF params with validated
  bounds against unlock-time alloc DoS, length-checked salt/nonce, zeroization of
  keys and plaintext, atomic 0600 writes. Solid.
- **SSH host-key verification** (`ssh/host_key.rs`, `session/ssh_host_key_verifier.rs`):
  the old blind-accept is gone (#1959/#1969) — desktop TOFU with a prominent
  MITM warning on a changed key (never auto-accepted), strict `known_hosts`-only
  default for headless/agent paths. Correctly wired into the handshake.
- **Plugin signature format** (`plugin/signature.rs`): domain-separated Ed25519
  over a canonical payload, exact-set digest match (no extra/missing entries),
  zip-bomb-bounded reads, tamper ≠ unsigned. Well designed (one nit: SEC-011).
- **Command construction**: no injectable shell strings found — Docker via
  `bollard` argv, SFTP paths `shlex`-quoted, RDP over stdin MessagePack, network
  tools use libraries/fixed argv. Clean.
- **Secret logging**: no secret values or password-bearing structs logged. Clean.
- **Frontend web/XSS**: no `dangerouslySetInnerHTML`/`innerHTML`/`eval`, no
  terminal link-addon, no markdown/HTML renderer, no `javascript:`/`target=_blank`
  sinks. Notably clean.
- **Desktop app update** is notify-only (no auto-install), so no desktop
  update-authenticity hole (the agent self-update is the one that matters — SEC-006).

## Trust boundaries

1. **Remote host / SSH-VNC-RDP-FTP server → app/agent** — untrusted wire data
   (host keys, VNC/RDP frames, dir contents, filenames). Gaps: SEC-007 (XSS),
   SEC-009/010 (alloc DoS). Host-key path is sound.
2. **Remote agent → desktop** — agent output rendered/handled by desktop. Frontend
   render path is clean; agent transport auth itself is the gap (SEC-004).
3. **Installed plugin → app process** — the weakest boundary: native plugins run
   *inside* the process with full privileges (SEC-002); the FS bridge that looks
   like a sandbox is lexical-only and symlink-escapable (SEC-003).
4. **Local process / malware → app & agent** — the agent `--listen` TCP port is
   unauthenticated (SEC-004); webview capabilities are unscoped (SEC-013).
5. **Webview (frontend) → OS** — via Tauri core plugins; unscoped fs/opener grants
   (SEC-013), unvalidated opener schemes (SEC-012). Test bridge shipped in release
   (SEC-005).
6. **Hostile config/workspace file → app** — connection config drives behavior;
   password env-expansion turns a config field into a secret-corruption /
   env-exfil vector (SEC-001).

## Top risks (ranked by exploitability × impact)

1. **SEC-002 (high)** — Native plugins run in-process, unsandboxed, fully
   privileged; the permission model enforces nothing against direct syscalls.
   Installing a plugin = arbitrary code with access to all credentials/sessions.
   *Architecture decision to make consciously before release.* **Release-relevant.**
2. **SEC-004 (high)** — Agent `--listen` TCP transport has no authentication; any
   local process (default `127.0.0.1`) — or the network if bound `0.0.0.0` — gets
   full agent control (spawn shells, read files). **Release-blocking if TCP mode ships.**
3. **SEC-001 (high)** — SSH/telnet/etc. passwords run through shell env-expansion:
   silent secret corruption *and* an env-var exfiltration channel to a malicious
   remote. Small, concrete fix. **Release-relevant.**
4. **SEC-007 (high)** — Embedded HTTP directory listing emits filenames + URL path
   unescaped → stored/reflected XSS delivered by the app's own (also agent-hosted)
   server, driven by hostile files.
5. **SEC-008 (high)** — HTTP monitor fetches arbitrary URLs with no SSRF guard;
   agent-side it reaches internal networks and the cloud metadata endpoint.
6. **SEC-006 (medium)** — Agent self-update trusts a same-origin SHA-256 checksum,
   not a signature → release-channel compromise = agent RCE. Off by default.
7. **SEC-003 (medium)** — Plugin FS-scope check is lexical-only; in-scope symlink
   escapes the declared roots (reads SSH keys). Compounds SEC-002.
8. **SEC-009 (medium)** — VNC framebuffer alloc from unbounded server resolution
   (~17 GB) → memory DoS from a hostile server.
9. **SEC-013 (medium)** — Webview granted unscoped fs read/write + open-path;
   least-privilege gap that magnifies any future frontend compromise.
10. **SEC-005 (medium, workaround)** — Test bridge + CSP-relaxation compiled into
    release; frontend activatable via localStorage/query, not just the env gate.
11. **SEC-010 / SEC-012 / SEC-011 (low)** — RDP drive read alloc cap; opener scheme
    validation; ed25519 `verify` → `verify_strict`.

## Release recommendation

Do not ship as-is at the stated bar. Blocking-tier before release: **SEC-001**
(tiny fix), **SEC-004** (gate/authenticate the TCP transport), **SEC-007** and
**SEC-008** (escape output / add SSRF guard), and an explicit **decision on
SEC-002** (out-of-process sandbox, or native plugins hard-off-by-default behind an
unmistakable "full privileges" gate). SEC-003/005/006/009/013 should follow close
behind; the lows are cheap hardening. `SECURITY.md` should also gain a "security
model / trust boundaries" section documenting the native-plugin and agent-transport
trust assumptions so operators are not surprised.

## Finding index

| ID | Sev | Title |
|----|-----|-------|
| SEC-001 | high | SSH/etc. passwords run through env-expansion (corruption + leak) |
| SEC-002 | high | Native plugin backends run in-process, unsandboxed, full-priv |
| SEC-003 | medium | Plugin FS-scope check lexical-only → symlink escape |
| SEC-004 | high | Agent `--listen` TCP transport is unauthenticated |
| SEC-005 | medium | Test bridge + CSP relaxation shipped in release builds |
| SEC-006 | medium | Agent self-update uses same-origin checksum, not a signature |
| SEC-007 | high | Embedded HTTP dir-listing XSS (unescaped filenames + URL path) |
| SEC-008 | high | HTTP monitor SSRF (metadata endpoint reachable) |
| SEC-009 | medium | VNC framebuffer unbounded alloc from server resolution (DoS) |
| SEC-010 | low | RDP drive read allocates on unbounded server length |
| SEC-011 | low | Plugin signatures use non-strict ed25519 verify |
| SEC-012 | low | Opener called with unvalidated URL schemes |
| SEC-013 | medium | Unscoped webview fs/opener capabilities (least privilege) |

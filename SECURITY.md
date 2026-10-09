# Security Policy

termiHub manages terminal connections, SSH sessions, credentials, and SFTP file
transfers, so security reports are taken seriously. Thank you for helping keep
termiHub and its users safe.

## Supported Versions

termiHub is pre-1.0 and under active development. Security fixes are applied to
the latest release and the `develop` branch only; older builds are not patched
retroactively.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1.0 | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
pull requests, or discussions.**

Instead, report them privately through GitHub Security Advisories:

1. Go to the [Security tab](https://github.com/armaxri/termiHub/security) of the
   repository.
2. Click **Report a vulnerability** to open a private advisory
   ([direct link](https://github.com/armaxri/termiHub/security/advisories/new)).
3. Fill in as much detail as you can (see below).

This keeps the report private between you and the maintainer until a fix is
available, and lets us coordinate disclosure responsibly.

### What to include

A good report helps us confirm and fix the issue quickly. Where possible,
include:

- A description of the vulnerability and its potential impact.
- The affected version, platform (Windows, macOS, or Linux), and connection type
  (local shell, SSH, serial, telnet, Docker, WSL, etc.) if relevant.
- Step-by-step instructions to reproduce the issue.
- Any proof-of-concept code, logs, or screenshots.
- Suggested mitigations, if you have them.

## Response Expectations

This is a community project maintained on a best-effort basis. We aim to:

- **Acknowledge** your report within **7 days**.
- Provide an initial **assessment** within **14 days**.
- Keep you informed about progress toward a fix, and credit you in the advisory
  once it is published (unless you prefer to remain anonymous).

Response times may vary with maintainer availability. If you have not heard back
within the acknowledgement window, feel free to send a polite follow-up through
the same private advisory thread.

## What Counts as a Security Issue

Security vulnerabilities are defects that could compromise the confidentiality,
integrity, or availability of termiHub or its users' systems and data. Examples
include:

- Exposure or mishandling of stored credentials, keys, or master passwords.
- Weaknesses in credential encryption or the credential store.
- Command, code, or path injection through connection configuration or terminal
  input.
- Improper handling of SSH host keys, tunnels, or X11 forwarding that could
  enable interception or impersonation.
- Leaking sensitive data through logs, crash reports, workspace files, or the
  embedded servers.
- Escaping the native plugin sandbox (see below): a native plugin that reaches
  files, the network, other processes or termiHub's own memory beyond what its
  sandbox and granted permissions allow.

The following are **not** security vulnerabilities and should be filed as normal
[GitHub issues](https://github.com/armaxri/termiHub/issues):

- Functional bugs with no security impact (crashes, rendering glitches, incorrect
  behavior).
- Feature requests and usability suggestions.
- Vulnerabilities in third-party dependencies with no demonstrated impact on
  termiHub (please report these upstream; you may still flag them if termiHub can
  mitigate).

When in doubt, treat it as a potential security issue and report it privately —
we would rather review an extra report than miss a real one.

## Native Plugin Sandbox

Native plugin backends are native code, so termiHub never loads them into its own
process. Each enabled native plugin runs in its own `termihub-plugin-runner`
helper process, confined by the operating system before any plugin code runs:

- **Linux:** `no_new_privs`, landlock, a seccomp filter, and a private user and
  network namespace where the system allows it.
- **macOS:** a Seatbelt profile.
- **Windows:** a per-plugin Less-Privileged AppContainer with no capabilities,
  inside a job object.

A sandboxed plugin can read its install folder and the system libraries, and
read and write only its private data folder (`HOME` and `TMPDIR` point there).
It cannot open other files, create network sockets, start programs, or reach
devices, the clipboard or the SSH agent. Network and file access that its
declared `network` / `filesystem` permissions grant goes through termiHub's
capability bridge, which checks every request before performing it. A crash,
hang or runaway allocation ends only that plugin's sessions.

If full isolation is unavailable (mostly a Linux kernel without landlock), the
plugin loads only after the user accepts reduced isolation for that exact build.
If the sandbox cannot be set up, the plugin does not load; there is no setting
to run a plugin without it. Native plugins remain off by default, and each one
still needs the user's trust acknowledgement, because the sandbox limits what a
plugin can reach, not what it draws in its own terminal. The acknowledgement
covers the exact library file and the access the user approved: the plugin's
permissions, its declared folders and its connection policy. An update or
reinstall that changes any of these, even only narrowing them, does not load
until the user reviews and trusts the plugin again. Acknowledgements recorded
before termiHub stored the approved access are treated as untrusted, and
uninstalling a plugin removes its acknowledgement. The design is ADR-19 in
[`docs/architecture.md`](docs/architecture.md); plugin authors find the rules in
[`docs/plugin-authoring.md`](docs/plugin-authoring.md#the-plugin-sandbox).

The sandbox raises the cost of an attack; it does not protect against kernel or
operating-system vulnerabilities.

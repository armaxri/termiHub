# Security Policy

termiHub is a cross-platform terminal hub that handles sensitive data such as
SSH credentials, private keys, and remote session contents. We take security
seriously and appreciate responsible disclosure of vulnerabilities.

## Supported Versions

termiHub is currently in its initial beta. Only the latest release receives
security updates.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1.0 | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, use one of the private channels below:

1. **GitHub Security Advisories (preferred)** — go to the
   [Security tab](https://github.com/armaxri/termiHub/security/advisories) of the
   repository and click **"Report a vulnerability"**. This opens a private
   advisory visible only to you and the maintainers.
2. **Email** — if you cannot use GitHub Security Advisories, send details to
   **armaxri@gmail.com**. Please include `[termiHub SECURITY]` in the subject
   line.

When reporting, please include as much of the following as possible to help us
triage quickly:

- A description of the vulnerability and its potential impact
- Steps to reproduce, or a proof-of-concept
- Affected version(s), platform(s), and connection type(s) (local shell, SSH,
  serial, telnet, Docker, remote agent)
- Any suggested mitigation or fix, if known

## Response Process

- **Acknowledgement**: we aim to acknowledge your report within **7 days**.
- **Assessment**: we will investigate and provide an initial assessment,
  including a severity rating and expected timeline, within **14 days**.
- **Resolution**: validated vulnerabilities will be fixed as quickly as is
  practical given severity. We will keep you informed of progress and notify you
  when a fix is released.
- **Disclosure**: we follow coordinated disclosure. Please give us a reasonable
  opportunity to release a fix before any public disclosure. With your
  permission, we will credit you in the release notes and advisory.

## What Counts as a Security Issue

Examples of issues that should be reported through the private channels above:

- Exposure, leakage, or insecure storage of credentials, private keys, or master
  passwords
- Weaknesses in the credential store encryption or master-password handling
- Remote code execution, command injection, or privilege escalation
- Path traversal or arbitrary file read/write via SFTP or the file browser
- Bypass of authentication or host-key verification for SSH or the remote agent
- Vulnerabilities in the remote agent's JSON-RPC protocol or session handling
- Vulnerabilities in the embedded HTTP/FTP/TFTP servers

## What Is Not a Security Issue

The following are expected behaviors or regular bugs and should be filed as
normal [GitHub issues](https://github.com/armaxri/termiHub/issues) rather than
security reports:

- **Telnet traffic is unencrypted** — this is inherent to the telnet protocol by
  design, not a termiHub vulnerability.
- **Beta binaries are unsigned** — macOS Gatekeeper and Windows SmartScreen
  warnings are expected for the unsigned beta artifacts.
- Crashes, UI glitches, or functional defects with no security impact.
- Vulnerabilities in third-party dependencies that are already publicly known
  and tracked upstream (though a heads-up is still welcome).

Thank you for helping keep termiHub and its users safe.

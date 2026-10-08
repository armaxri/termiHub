---
id: MKT2-001
title: "README plugin trust warning contradicts the shipped plugin sandbox (ADR-19) and default-off setting"
angle: marketing / product positioning
severity: medium
category: docs-accuracy
is_workaround: false
subsystem: "README.md / plugin system"
evidence:
  - "README.md:124"
  - "README.md:152"
  - "docs/architecture.md:3456-3510"
  - "SECURITY.md:90-117"
  - "docs/plugin-authoring.md:487-575"
  - "src/components/Settings/settingsRegistry.ts:721-725"
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

README.md:152 still warns that native plugins 'run arbitrary code with your full user privileges' and that 'an untrusted native plugin can do anything your user account can'. README.md:124 says native backends are 'loaded over a C ABI'. ADR-19 (accepted 2026-10-08, #4189) removed in-process loading. Every native plugin now runs in a separate termiHub-plugin-runner process confined by the OS sandbox (landlock/seccomp on Linux, Seatbelt on macOS, AppContainer on Windows). It has no file access outside its data folder, no sockets, no child processes and no SSH agent. Native plugins are also off by default (settingsRegistry.ts:721-725). The README mentions neither the sandbox nor the default-off setting, while SECURITY.md and plugin-authoring.md describe both correctly.

## Why it matters

This is the README's only security callout, and it is now factually wrong in the alarming direction. It tells prospects the opposite of the product's strongest security story: that is still the worst-case pre-ADR-19 threat model. Security-minded evaluators (the core audience for SSH/serial/infrastructure tooling) will either avoid plugins or take the project as less careful than it is. Meanwhile the README and SECURITY.md contradict each other on the same question.

## Evidence

- `README.md:124`
- `README.md:152`
- `docs/architecture.md:3456-3510`
- `SECURITY.md:90-117`
- `docs/plugin-authoring.md:487-575`
- `src/components/Settings/settingsRegistry.ts:721-725`

## Recommendation

Rewrite README.md:124 and the callout at :152 to match SECURITY.md. State three things. Native plugins are off by default (Settings → Plugins → Enable Native Plugins). Each one runs in its own OS-sandboxed helper process that cannot read your files, ~/.ssh, the credential vault or the network except through permissions you grant. Installing one is still a trust decision, because the sandbox does not limit what it draws in its own terminal and does not protect against kernel escapes. Link SECURITY.md#native-plugin-sandbox. Also add a docs-consistency check (or a release-check grep) so ADR changes that touch security claims trigger a README review.

## Verification

I confirmed the finding against the code, but I rate it medium, not high. In dev9 at 663465d52, README.md:124 still says native backends are "loaded over a C ABI". The callout at README.md:152 still says native plugins "run arbitrary code with your full user privileges" and "can do anything your user account can". It mentions neither the sandbox nor that native plugins are off by default. That contradicts four other sources. First, ADR-19 in docs/architecture.md:3456+ (accepted 2026-10-08, #4189, closes SEC-002) says plugins load only in a sandboxed `termihub-plugin-runner` process and the host no longer dlopens them. Second, SECURITY.md:90-119 has a "Native Plugin Sandbox" section. Third, the setting at settingsRegistry.ts:721-725 is described as "Off by default: native plugins run in a separate, sandboxed process". Fourth, the runner is real code: `plugin-runner/` in Cargo.toml and Cargo.lock, referenced from src-tauri session code. Nothing in the README describes the newer model, and I found no ADR or FINAL-SUMMARY entry that keeps the old wording on purpose. FINAL-SUMMARY lists only MKT-003, about screenshots, against the README. Why medium: this is a stale doc that overstates the risk, not a security hole. Users are warned too much, never too little, and the "installing a plugin is a trust decision" advice is still right. The README fell behind the day after ADR-19 landed. The fix is a small README edit that points to SECURITY.md.

---
id: UX-034
title: Host-key prompt fingerprint isn't copyable and a changed key shows no old-vs-new comparison
angle: ux-flows
severity: low
category: ux
is_workaround: false
subsystem: src/components/SshHostKeyPrompt
evidence:
  - src/components/SshHostKeyPrompt/SshHostKeyPrompt.tsx:123
  - src/components/SshHostKeyPrompt/SshHostKeyPrompt.tsx:104
status: open
---

## What
The SSH host-key prompt is otherwise strong (clear Reject / Accept-once / Accept-for-host choices,
a prominent MITM `role="alert"` warning when the key changed, host/type/SHA-256 fingerprint shown,
ESC = reject). Two polish gaps: the fingerprint (`SshHostKeyPrompt.tsx:123-134`) is not individually
copyable, and on a **changed** key (`:104-117`) there is no side-by-side old-vs-new fingerprint
comparison — the user must eyeball-verify against whatever they have elsewhere.

## Why it matters
Verifying a host key is a security-critical decision. Not being able to copy the fingerprint makes
out-of-band verification (paste into a comparison, search a known-hosts record) harder, and showing
only the new fingerprint on a *changed* key gives the user nothing to compare against in-app — right
when the MITM warning is telling them to be careful.

## Evidence
- `SshHostKeyPrompt.tsx:123-134` — fingerprint rendered as plain text, not copyable.
- `SshHostKeyPrompt.tsx:104-117` — changed-key warning shows the new key only, no prior fingerprint.

## Recommendation
Make the fingerprint copyable (a copy button), and on a changed key show both the previously-trusted
and the new fingerprint side by side with the differing portion highlighted, so the user can verify
the change deliberately.

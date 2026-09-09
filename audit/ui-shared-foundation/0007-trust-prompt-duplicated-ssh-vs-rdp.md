---
id: UISF-007
title: SSH host-key prompt and RDP cert prompt are the same trust dialog implemented twice
angle: ui-shared-foundation
severity: medium
category: ui
is_workaround: false
subsystem: src/components/SshHostKeyPrompt
evidence:
  - src/components/SshHostKeyPrompt/SshHostKeyPrompt.tsx:57
  - src/components/SshHostKeyPrompt/SshHostKeyPrompt.tsx:104
  - src/components/RemoteDesktop/RemoteDesktopCertPrompt.tsx:30
  - src/components/RemoteDesktop/RemoteDesktopCertPrompt.tsx:74
status: open
---

## What

`SshHostKeyPrompt.tsx` and `RemoteDesktopCertPrompt.tsx` are structurally identical trust prompts
built twice with different BEM prefixes (`ssh-hostkey__` vs `rd-cert__`). `SshHostKeyPrompt.tsx:10`
even documents itself as "the terminal analogue of the RDP RemoteDesktopCertPrompt."

Both render, in the same order:
- a title with `ShieldAlert`/`ShieldCheck` toggled on `changed` (SshHostKeyPrompt.tsx:62-74 ≈ RemoteDesktopCertPrompt.tsx:35-45),
- an identical MITM `__warning` block (SshHostKeyPrompt.tsx:104-116 ≈ RemoteDesktopCertPrompt.tsx:74-83),
- a `dl.__facts` host/fingerprint layout (SshHostKeyPrompt.tsx:123-134 ≈ RemoteDesktopCertPrompt.tsx:89-108),
- the same three-button footer: ghost "Reject" / secondary "Accept once" / `changed?"danger":"primary"` "Accept for host" (SshHostKeyPrompt.tsx:76-100 ≈ RemoteDesktopCertPrompt.tsx:46-70).

## Why it matters

This is a security-sensitive dialog (host-key / certificate trust). Having two copies means the two
protocols' trust UX will drift — one could gain a clearer warning, a Caps-Lock note, or a different
default button, and the other silently won't. The `__warning` MITM copy and the three-verdict footer
are exactly the parts you want identical across both.

## Evidence

See frontmatter. The two files differ only in the noun ("Host key" vs "Certificate"), the fact rows,
and the class prefix; the layout, icons, warning block, and footer are duplicated.

## Recommendation

Extract a shared `TrustPrompt` component (in `src/components/ui/` or a shared `security/` folder)
parameterised by title noun, the `changed` flag, a `facts` list ({label, value}), and the three
verdict callbacks. Render both SSH and RDP prompts through it. This keeps the MITM warning and the
three-verdict footer identical across protocols and removes ~120 lines of duplicated markup + CSS.

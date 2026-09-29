# Marketing / product-positioning audit — termiHub

**Angle:** how termiHub presents itself to prospective users — the README (the primary
shopfront), concept/mockup docs, branding/icons, feature messaging, changelog, and trust
signals — for a public v0.1.0 launch. Read-only. Method: read the README and concept corpus as
a prospect would (first-30-seconds test), then cross-check every claim against the real feature
set using the product-completeness and connection-parity audit findings.

**14 findings (MKT-001 … MKT-014).**

## Headline assessment

The gap here is a **positioning/presentation failure, not a product failure.** The
product-completeness audit is blunt: termiHub is "far more complete than a typical pre-v0.1.0
codebase" — real RDP/VNC, a native-ABI plugin system with code-signing, remote agents, session
restore, tunnels, network diagnostics, embedded servers, macros, multi-window, broadcast. The
shopfront hides most of it. **The README markets roughly a third of the product and reads like
a competent-but-ordinary SSH/serial/telnet client.** The single most valuable marketing action
here is *not writing new copy but accurately describing what already ships.*

Second-order problems compound it: no screenshots for a visual app, no value proposition or
competitive framing, no feature matrix, unfinished branding, and a changelog that reads as
internal engineering notes.

### Shopfront quality (first-30-seconds test): **weak**
Logo + generic one-liner + CI badges + install steps. No screenshot, no "what it looks like",
no "why use it", no scannable breadth. A prospect cannot tell in 30 seconds that this is a
multi-protocol hub with remote desktop and plugins.

### Positioning & differentiation: **absent**
The word "hub" is asserted, never defended. No target user, no differentiators, no comparison
vs PuTTY/iTerm/Termius/MobaXterm/Tabby/Windows Terminal. The genuine edges (terminal + graphical
remote desktop in one app, persistent remote agents, session restore, signed plugins, built-in
network tools, cross-platform + MIT) are all left unstated.

### Feature-messaging accuracy (both directions):
- **Undersell (dominant problem):** RDP/VNC absent entirely (MKT-001); plugins, network tools,
  FTP, embedded servers, macros, multi-window, broadcast, tab groups/workspaces, session
  restore, jump hosts, syntax highlighting all missing from Features (MKT-002); narrow tagline
  (MKT-013).
- **Oversell (isolated but embarrassing):** Docker "connect to running containers" when there is
  no exec into a running container (MKT-005). One clear first-use trust break; the rest of the
  README errs toward saying too little, not too much.

### Visual presentation: **unfinished**
No product screenshots/GIFs (MKT-003); placeholder emoticon logo + orphaned `termihub_old.svg`
+ open app-icon direction + no social-preview image (MKT-009). A rich concept/mockup corpus
exists but is invisible to prospects (MKT-010).

### Trust & credibility: **mixed**
Strong SECURITY.md and honest, above-average unsigned-beta expectation-setting (per-OS steps).
But the security posture is not sold as a differentiator and the unsigned warning lacks a
"why / it's safe" reassurance (MKT-014). Changelog reads as internal dev notes (MKT-011).

## Top gaps ranked by launch impact

1. **MKT-001 (high)** — RDP/VNC remote desktop absent from README. Biggest undersell; a
   fully-built flagship that's both experimental-gated *and* undocumented = no user will find it.
2. **MKT-002 (high)** — README omits most shipped features (plugins, network tools, FTP,
   embedded servers, macros, multi-window, broadcast, workspaces, session restore, jump hosts).
3. **MKT-003 (high)** — No screenshots/GIFs for a visual desktop app; UI shown as ASCII art.
4. **MKT-004 (high)** — No value proposition / differentiation / competitive framing; "why
   termiHub" is never answered.
5. **MKT-005 (medium)** — Docker "connect to running containers" oversell (run-new-only).
6. MKT-006 (medium) — No at-a-glance feature/capability matrix.
7. MKT-007 (medium) — No end-user first-connection quickstart (dev "Quick Start" ≠ onboarding).
8. MKT-008 (medium) — Emphasis inverted: experimental Workflows featured, shipped flagships not.
9. MKT-009 (medium) — Unfinished branding: placeholder logo, dead `_old.svg`, no social image.
10. MKT-011 (medium) — Changelog dominated by internal test/CI entries, not release highlights.
11. MKT-010 / MKT-012 / MKT-013 / MKT-014 (low) — unsurfaced concept corpus; broken README
    concept link; narrow tagline; underused trust signals.

## Biggest undersell vs biggest oversell
- **Biggest undersell:** RDP/VNC (MKT-001) — a real, distinctive graphical-remote-desktop
  capability that appears nowhere in the README, backed up by the broader feature omissions in
  MKT-002.
- **Biggest oversell:** Docker "Connect to running containers" (MKT-005) — the product is
  run-new-only and cannot exec into a running container, the most common Docker workflow.

## Launch-readiness verdict: **NOT launch-ready as presented.**
The binary may be ready; the shopfront is not. None of the gaps are hard — they are copy,
screenshots, and a branding decision, not engineering — but a public v0.1.0 launched with the
current README would badly undersell a strong product and stumble on at least one first-use
accuracy claim.

## What the README / launch needs (concrete checklist)
- [ ] **Hero screenshot** of the real app + one signature-interaction **GIF** (MKT-003).
- [ ] **Value-prop paragraph + "Why termiHub" bullets + comparison table** vs the obvious
      alternatives (MKT-004); define the "terminal hub" category.
- [ ] **Complete, grouped Features list** incl. RDP/VNC, plugins, network tools, FTP, embedded
      servers, macros, multi-window, broadcast, workspaces, session restore, jump hosts
      (MKT-001, MKT-002); honest experimental labels; rebalance emphasis (MKT-008).
- [ ] **Feature/capability matrix** with maturity/experimental markers (MKT-006).
- [ ] **End-user "Getting started" quickstart** (3–5 steps to first connection) distinct from
      the developer Quick Start (MKT-007).
- [ ] **Fix accuracy:** reword Docker (MKT-005); fix the README internal connection-type list;
      fix the broken concept link (MKT-012); don't market dead controls (SFTP pause/resume, FTP
      transfer engine) if those areas are added.
- [ ] **Finalize branding:** settle logo/icon, delete `termihub_old.svg`, add a social-preview
      image, set the GitHub About/description + topics (MKT-009, MKT-013).
- [ ] **Curated changelog Highlights** block; fold internal test/CI entries (MKT-011).
- [ ] **Sell trust:** short Security & privacy blurb + link SECURITY.md; add "why unsigned / it's
      safe" reassurance to the beta note (MKT-014). Keep the (good) per-OS unsigned steps.
- [ ] Surface the **concept/mockup gallery** from Documentation (MKT-010).

## Finding index
| ID | Sev | Title |
|----|-----|-------|
| MKT-001 | high | RDP/VNC remote-desktop absent from README (biggest undersell) |
| MKT-002 | high | README omits most shipped features |
| MKT-003 | high | No screenshots/GIFs for a visual app |
| MKT-004 | high | No value prop / differentiation / competitive framing |
| MKT-005 | medium | Docker oversell — "connect to running containers" (run-new-only) |
| MKT-006 | medium | No at-a-glance feature/capability matrix |
| MKT-007 | medium | No end-user first-connection quickstart |
| MKT-008 | medium | Emphasis inverted — experimental Workflows featured over flagships |
| MKT-009 | medium | Unfinished visual identity / branding (+ dead `_old.svg`) |
| MKT-010 | low | Concept/mockup corpus not surfaced |
| MKT-011 | medium | Changelog reads as internal dev notes, not release notes |
| MKT-012 | low | Broken README concept link (stale backlog/ path) |
| MKT-013 | low | Tagline / repo description undersells breadth |
| MKT-014 | low | Trust signals underused; unsigned-beta lacks "why/it's safe" |

# Marketing content drafts (MKT-\*)

This folder holds **review drafts** of user-facing marketing / release content for the
v0.1.0 beta. Nothing here is published anywhere yet — these files exist so the maintainer
can edit, approve, and then fold the approved parts into their canonical homes (top of
`README.md`, `CHANGELOG.md`, etc.) at release time.

They were produced from the audit's `MKT-*` findings. Every capability claim is grounded
in shipped code and the current `README.md` (verified at authoring time); experimental /
beta features are marked as such. No screenshots, logos, taglines, or metrics were
invented — those are called out below as maintainer-only follow-ups.

## What's here

| File                           | Covers                                                                        | Proposed home                              |
| ------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------ |
| `value-proposition.md`         | Positioning: what termiHub is, who it's for, why it beats a plain terminal    | Top of `README.md` (replace intro block)   |
| `feature-matrix.md`            | Capability matrix grouped by area, one line each, beta/experimental flagged   | `README.md` "Features" or a standalone doc |
| `quickstart.md`                | Install → first local shell → first SSH connection, using the real UI/scripts | `README.md` "Usage" or a standalone doc    |
| `release-notes-0.1.0-draft.md` | Curated Keep a Changelog draft for the v0.1.0 release notes                   | `CHANGELOG.md` `[0.1.0]` at release time   |

## Maintainer-only follow-ups (cannot be produced automatically)

These need a human decision or a real asset and were deliberately **not** invented:

- **Brand identity sign-off** — final logo, wordmark, color/tagline. The drafts reuse the
  existing one-line description as a placeholder tagline; no new tagline was coined.
- **Screenshots / GIFs** — the value-prop and quickstart mark `TODO(maintainer)` spots
  where a screenshot or short GIF (main window, first connection, split view) should go.
  No fabricated or placeholder images are included.
- **Positioning-claim vetting** — the "vs. other terminal managers" framing in
  `value-proposition.md` is deliberately conservative and comparison-light; the maintainer
  should confirm the competitive framing before it goes public.
- **Numbers / metrics** — no benchmarks, user counts, or performance figures are claimed.
  Add any only if independently verifiable.
- **Changelog curation** — `release-notes-0.1.0-draft.md` is a curated _net-change_ summary,
  not a mechanical dump of the 590+ per-branch fragments in `docs/changes/**`. Final
  wording and any omissions/additions are the maintainer's call at release time.

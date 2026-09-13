---
id: MKT-009
title: Visual identity is unfinished — placeholder emoticon logo, orphaned old SVG, no social-preview image, app-icon direction still open
angle: marketing / branding
severity: medium
category: ui
is_workaround: true
subsystem: public/ / docs/concepts/backlog/app-icons.html
evidence:
  - public/termihub.svg
  - public/termihub_old.svg
  - docs/concepts/backlog/app-icons.html
  - docs/concepts/README.md:111
status: open
---

## What
termiHub's brand identity is not launch-finalized:

- The logo (`public/termihub.svg`) is a **monospace emoticon** — two `^` "eyes" and a rotated
  `)` "mouth" rendered as `<text>` glyphs on a gradient rounded square. It's charming but reads
  as a placeholder/hobby mark, not a finished product logo; the glyphs also depend on font
  rendering (`SF Mono`/`Fira Code`/`Consolas`).
- A superseded **`public/termihub_old.svg`** is still committed alongside it — a dead asset with
  no references in the codebase (only in git index). Stopgap clutter.
- The app-icon concept sits in **`backlog/`** and its own README note says the icon direction is
  "an open maintainer call (UI-icon family still unbuilt)" — i.e. branding is knowingly not
  settled.
- There is **no social-preview / Open Graph image** for the repo, so links shared to
  Slack/Twitter/GitHub cards render with no branded thumbnail.
- No wordmark treatment; the README title is plain text.

## Why it matters
For a public v0.1.0, the logo/icon is the first and most-repeated brand impression (dock icon,
installer, DMG, README, GitHub avatar, link cards). A placeholder-grade mark and a missing
social image undercut the "this is a real, polished product" signal that the mature codebase
has otherwise earned. The orphaned `_old.svg` is exactly the kind of pre-release stopgap to
clear.

## Evidence
- `public/termihub.svg` — glyph-based emoticon logo, font-dependent `<text>` rendering.
- `public/termihub_old.svg` — orphaned prior logo, unreferenced (`is_workaround`).
- `docs/concepts/backlog/app-icons.html` + `docs/concepts/README.md:111` — icon direction open.

## Recommendation
- Decide the app-icon/logo direction before launch (resolve the backlog concept). If the
  emoticon stays, ship it as a proper vector mark that doesn't depend on system fonts (convert
  the glyphs to paths) and generate the full icon family from it.
- **Delete `public/termihub_old.svg`** (dead asset) once the mark is settled.
- Add a **1280×640 social-preview image** and set it as the repo's Open Graph image.
- Add a simple wordmark/banner to the README hero.

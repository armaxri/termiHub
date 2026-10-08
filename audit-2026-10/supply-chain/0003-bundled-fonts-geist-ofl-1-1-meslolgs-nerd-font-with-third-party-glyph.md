---
id: SUP2-003
title: "Bundled fonts (Geist OFL-1.1, MesloLGS Nerd Font with third-party glyph sets) are missing from the third-party notices; the Geist OFL text is not shipped"
angle: supply-chain
severity: low
category: licensing
is_workaround: false
subsystem: "licensing / frontend assets"
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
evidence:
  - src/styles/fonts.css:2
  - src/styles/fonts.css:8
  - src/styles/fonts.css:17
  - src/assets/fonts/Geist-OFL.txt:3
  - public/fonts/LICENSE:1
  - src-tauri/tauri.conf.json:10
  - scripts/internal/third-party-notices.mjs:69
  - THIRD_PARTY_LICENSES.md:16
  - docs/licensing.md:109
---

## What

The app embeds two vendored fonts through frontendDist (../dist). Geist-Variable.woff2 is imported from src/styles/fonts.css:8 and emitted as dist/assets/`Geist-Variable-*.woff2`. `MesloLGSNerdFontMono-*.ttf` is copied from public/fonts. Geist is SIL OFL-1.1, but its license file src/assets/fonts/Geist-OFL.txt is imported by nothing, so it never reaches dist. The Meslo LICENSE in public/fonts covers only the Apache-2.0 base font, not the Nerd Fonts patched glyph sets (Font Awesome OFL, Material Design, Octicons, Codicons, Powerline and others). Neither font appears in THIRD_PARTY_LICENSES.md, licenses/, or EXTERNAL_TEXTS in third-party-notices.mjs. The generated THIRD_PARTY_NOTICES.txt covers only lockfile packages plus those external texts. The notices pipeline and docs (licensing.md:109-140, THIRD_PARTY_LICENSES.md:7-20) describe themselves as the complete attribution for everything bundled.

## Why it matters

OFL-1.1 condition 2 requires every distributed copy of the font to carry the copyright notice and license. Apache-2.0 and the glyph-set licenses also require attribution. Every installer currently ships the Geist font with no OFL text and the Nerd Font glyphs with incomplete attribution. This is a real, if small, distribution-license non-compliance in the shipped app, and the notices gate (PKG-009) cannot detect it because fonts are not lockfile packages.

## Recommendation

Add a 'Bundled fonts' section to THIRD_PARTY_LICENSES.md (Geist: Vercel, OFL-1.1; MesloLGS NF: André Berg, Apache-2.0, plus the Nerd Fonts glyph-source licenses). Add licenses/OFL-1.1-geist.txt and the Nerd Fonts license texts to EXTERNAL_TEXTS in third-party-notices.mjs so they land in THIRD_PARTY_NOTICES.txt. Optionally, extend `notices:check` to fail when a `*.woff2`/`*.ttf`/`*.otf` under src/ or public/ has no EXTERNAL_TEXTS entry.

## Verification

Confirmed. Geist-OFL.txt is imported by nothing, so it is not emitted into dist. No font appears in THIRD_PARTY_LICENSES.md, licenses/ or the notices script. Two mitigations lower it to low: public/fonts/LICENSE (Meslo base, Apache-2.0) is copied into dist because it sits in public/, and the font binaries carry copyright metadata (the Meslo TTF shows copyright strings). OFL-1.1 allows the notice to live in machine-readable metadata fields. Still, the notices pipeline that claims to be complete omits both fonts and the Nerd Fonts glyph-set licenses.

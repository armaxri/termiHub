# UI / Visual-Design audit — summary

**Angle:** Visual craft and consistency — layout, spacing, typography, color/theming,
component polish, states, iconography, dark/light correctness. Reasoned from CSS/markup
(the app cannot be run here). Scope: `src/components/**`, `src/components/ui/**`,
`src/styles/**`, `src/themes/**`. Overlaps with the shared-foundation and accessibility
experts by design; this lens is *how it looks*.

## Overall read

The design-token *foundation* is genuinely good and, unusually, **actively enforced** — a
`tokenDiscipline.test.ts` ratchet blocks bare `#fff`, standalone raw hex, the `rgba(0,0,0,0.7)`
scrim, and per-component scrollbar overrides, plus an undefined-token guard. Where the system
is used (the `ui/` primitives, most dialogs, the flat sidebars), the app is visually coherent:
one button/input/modal language, one motion language, reduced-motion handled, `color-mix`
derivations that track the accent.

But the enforcement has **specific blind spots the app has drifted into**, and there is one
**systemic theming problem at the root**:

1. **Two disagreeing palettes (UI-001).** `variables.css` `:root` defines a bespoke "premium"
   bluish dark palette (`#0f1117…`), but the theme engine overrides every color token at
   runtime with a flat **VS Code** palette from `dark.ts` (`#1e1e1e…`). The premium palette —
   and the visual identity the file's own comments describe — **never renders**. The token file
   is half-authoritative (spacing/radius/shadows/fonts are real) and half-dead (colors), with
   nothing marking which. This is the highest-leverage visual finding: it's why the app looks
   more generic than its own tokens intend, and it's a trap for anyone retuning the look.

2. **The guard only catches what it names.** It blocks *one* exact scrim and bare white, so
   **arbitrary `rgba()` colors sail through** — including hardcoded accent-blues that ignore
   the active theme (UI-003) and raw scrims/shadows (UI-004). There is **no guard at all** for
   z-index (UI-002), font-size (UI-005), border-radius (UI-006), or spacing (UI-009), and those
   are exactly the four axes that have drifted.

3. **Scales are too small for what the app uses.** The type scale is 11–14px but the UI runs
   8–22px (UI-005); the radius scale is missing 3/5/8px tiers the code wants (UI-006); z-index
   has 2 tokens for a ~9-layer stack (UI-002). So components invent off-scale values and rhythm
   fragments.

Theming correctness is mostly sound for the two built-in themes (contrast is regression-tested
for the risky text tokens, Solarized palettes are complete with all 58 keys). The theme-fidelity
gaps are: hardcoded accent-blues that break under Solarized/custom themes (UI-003), a focus glow
frozen to one blue (UI-007), and elevation shadows that don't theme (UI-012).

## Systemic issues (ranked)

1. **Palette source-of-truth split (UI-001)** — the shipped look ≠ the designed tokens.
2. **rgba/accent colors that bypass tokens and don't track the theme (UI-003, UI-004)** — visible
   theme breakage in the drop-zone and network tools under non-blue themes.
3. **Z-index has no scale and the stack is incoherent (UI-002)** — update banner (9000) and noise
   overlay (9999) render *above* modals/toasts (1000); a real stacking bug waiting to surface.
4. **Type scale gap + ~140 raw px font-sizes (UI-005)** — no caption/display tiers; rhythm drifts.
5. **Overlay backdrops for the same surface diverge 4 ways (UI-008)** — connecting/disconnected/
   error/remote states look like different systems; raw `blur(2px)` off-token.
6. **Radius (UI-006) and spacing (UI-009) drift** — off-scale near-tokens; no guards.
7. **Theme-frozen focus ring (UI-007) and shadows (UI-012)** — don't track the active theme.

## Top 5 issues

1. **UI-001** (medium) — Two palettes; the premium `variables.css` colors never ship (VS Code
   palette wins at runtime). Fix source-of-truth + add a parity test.
2. **UI-002** (medium) — Z-index magic numbers, no scale; UpdateNotification (9000) & noise
   overlay (9999) stack above modals/toasts (1000). Define a z-scale + guard.
3. **UI-003** (medium) — Hardcoded `rgba(38,132,255…)` accent-blue in the split drop-zone and
   `rgba(0,122,204…)` in NetworkTools ignore the theme accent; jarring under Solarized/custom.
4. **UI-005** (medium) — Type scale is 11–14px but the app uses 8–22px with no tokens for the
   caption/display tiers; ~140 raw px font-sizes.
5. **UI-008** (medium) — Terminal-covering overlays use four different backdrop treatments
   (opaque / translucent+blur(2px) / modal scrim) for the same conceptual surface.

## Release-relevant visual gaps

- **Theming under non-blue themes is visibly broken in spots** (UI-003, UI-007): the drag-split
  preview and every focus ring stay blue regardless of the chosen theme accent. Anyone shipping
  or using a custom/Solarized theme sees the clash immediately. Not a crash, but a clear
  "unfinished" tell on a headline feature (custom themes).
- **The shipped visual identity is not the designed one (UI-001).** If the `#0f1117` premium
  palette was the intended brand look, the release currently ships plain VS Code dark instead.
  Worth an explicit decision before release, not silent drift.
- **Light-theme elevation is dark-tuned (UI-012)** and **the update banner can render over
  modals (UI-002)** — both light-mode/edge polish rather than blockers.

No contrast/keyboard/focus-visibility *correctness* judgements are made here — those are the
accessibility expert's call; UI-007 and UI-005 note the visual side only.

## Finding index

| ID | Sev | Workaround | Title |
|----|-----|-----------|-------|
| UI-001 | medium | no | Two disagreeing palettes — premium variables.css colors never render |
| UI-002 | medium | yes | Z-index magic numbers, no scale; incoherent stacking |
| UI-003 | medium | no | Hardcoded accent-blue in drop zones / network results ignores theme |
| UI-004 | medium | no | Raw rgba() scrims, white overlays & box-shadows bypass tokens |
| UI-005 | medium | no | Type scale gap (no 8–10 / 15–22px tokens); ~140 raw px font-sizes |
| UI-006 | low | no | Border-radius drift — raw 3/5/8/100px near-tokens |
| UI-007 | low | no | Focus ring glow hardcoded blue, doesn't track theme accent |
| UI-008 | medium | no | Terminal-covering overlays use 4 different backdrop treatments |
| UI-009 | low | no | ~366 raw px paddings/margins/gaps bypass the spacing scale |
| UI-010 | low | yes | !important overrides on color picker + stale-stat coloring |
| UI-011 | low | no | var(--token,#hex) fallbacks carry inconsistent stale values |
| UI-012 | low | no | Static dark-tuned shadows weaken depth in the light theme |

# Concept Mockup Assets

Shared assets for the **AI-driven concept workflow**. See the concept itself:
[`backlog/ai-driven-concept-workflow.md`](../backlog/ai-driven-concept-workflow.md).

| File                                           | Purpose                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| [`mockup.css`](mockup.css)                     | Shared chrome kit — mirrors the app's real component class names + theme values |
| [`mockup-template.html`](mockup-template.html) | Copy-and-edit skeleton (corrected structure + inline lucide icon sprite)        |

## What a mockup is (and is not)

A mockup is a **hand-written, layout-altitude** HTML file that shows the **structure and
states** of a screen or element. It is the visual half of a concept — the unambiguous picture
a human reviews and Claude Code uses as the layout target before implementing.

It is **not** a pixel-perfect reproduction of the live app, and it is **not** generated from the
real components. It is allowed to be _directionally right, not current_ between syncs.

## Conventions

1. **Self-contained.** Link only `../../../_assets/mockup.css`. Never import app code, never add
   a build step. A light inline `<script>` is allowed only to toggle between mock states.
2. **Use the real class names.** `mockup.css` mirrors the app's actual BEM class names and values
   (`.activity-bar__item`, `.tab`, `.terminal-view__toolbar`, `.status-bar`, …) so the mockup DOM
   matches the real DOM. Reproduce structure and theme, not every pixel.
3. **Use real lucide icons.** Copy the needed `<symbol>` definitions from the inline sprite in
   [`mockup-template.html`](mockup-template.html) (real lucide geometry) and reference them with
   `<svg class="li"><use href="#i-name" /></svg>`. Don't use unicode glyphs.
4. **One screen/region per file.** `toolbar.html`, `target-picker.html`, `main-view.html`.
5. **Annotate.** Mark non-obvious regions with `<span class="callout">A</span>` and add a
   `.legend` explaining each.
6. **Show the state space.** Where it helps, put states side by side with `.states` so a reviewer
   sees empty / loading / active / error at a glance.

## Class quick reference (real app classes)

| Area         | Classes                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window       | `.app`, `.app__body`                                                                                                                                                      |
| Activity bar | `.activity-bar`, `.activity-bar__top` / `__bottom`, `.activity-bar__item` (`--active`), `.activity-bar__indicator`                                                        |
| Sidebar      | `.sidebar`, `.sidebar__header`, `.sidebar__title`, `.sidebar__content`, `.connection-tree__item` (`--selected`)                                                           |
| Toolbar row  | `.terminal-view__toolbar`, `.terminal-view__toolbar-actions`, `.terminal-view__toolbar-btn` (`--active`, `--broadcast-active`)                                            |
| Tabs / panel | `.terminal-view__content`, `.panel` (`--broadcast-source` / `--broadcast-target`), `.tab-bar`, `.tab` (`--active`), `.tab__title`, `.tab__close`, `.tab__broadcast-badge` |
| Terminal     | `.terminal`, `.terminal .prompt`, `.terminal .cursor`                                                                                                                     |
| State dots   | `.state-dot` (`--connected` / `--connecting` / `--disconnected`)                                                                                                          |
| Status bar   | `.status-bar`, `.status-bar__section` (`--left`/`--center`/`--right`), `.status-bar__item` (`--broadcast`, `--broadcast-warning`)                                         |
| Menus        | `.menu`, `.menu__title`, `.menu__row` (`--selected`), `.menu__footer`, `.radio`, `.check`                                                                                 |
| Buttons      | `.btn` (`--primary` / `--link`)                                                                                                                                           |
| Icons        | `.li` + inline `<use href="#i-name" />` sprite                                                                                                                            |
| Annotation   | `.callout`, `.legend`, `.states`, `.state-label`                                                                                                                          |

## Tooling

- **Index** — `scripts/internal/build-mockups-index.sh` (or `.cmd`) regenerates
  [`../mockups-index.html`](../mockups-index.html), a browsable page linking every mockup.
- **Screenshots** — `scripts/internal/screenshot-mockup.sh <file.html>` (or `--all`) renders
  mockups to PNG via headless Chrome into `.preview/` (gitignored) for quick visual review and
  fidelity checks.

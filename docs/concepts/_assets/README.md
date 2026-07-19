# Concept Assets

Shared assets for the **AI-driven concept workflow**. See the concept itself:
[`implemented/ai-driven-concept-workflow.html`](../implemented/ai-driven-concept-workflow.html).

A concept with a visual surface is **one self-contained HTML file**
(`docs/concepts/<status>/<name>.html`) that links the shared assets below and holds prose, Mermaid
diagrams, mockups, and the sync ledger together.

| File                                             | Purpose                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [`concept-template.html`](concept-template.html) | **Copy-me scaffold** for a new single-file concept (sections + sprite + Mermaid init) |
| [`concept.css`](concept.css)                     | Document styling — prose, headings, tables, diagram cards, table of contents          |
| [`mockup.css`](mockup.css)                       | App-chrome kit — mirrors the app's real component class names + theme values          |
| [`mermaid.min.js`](mermaid.min.js)               | Vendored, pinned Mermaid — renders `<pre class="mermaid">` diagrams offline           |
| [`mockup-template.html`](mockup-template.html)   | Legacy standalone-mockup skeleton (folder form); kept for reference                   |

## What a mockup is (and is not)

A mockup is a **hand-written, layout-altitude** HTML file that shows the **structure and
states** of a screen or element. It is the visual half of a concept — the unambiguous picture
a human reviews and Claude Code uses as the layout target before implementing.

It is **not** a pixel-perfect reproduction of the live app, and it is **not** generated from the
real components. It is allowed to be _directionally right, not current_ between syncs.

## Conventions

1. **Self-contained.** From a concept at `<status>/<name>.html`, link only the shared assets —
   `../_assets/mockup.css`, `../_assets/concept.css`, `../_assets/mermaid.min.js`. Never import app
   code, never add a build step. A light inline `<script>` is allowed only to toggle mock states
   (the Mermaid init script is expected).
2. **Use the real class names.** `mockup.css` mirrors the app's actual BEM class names and values
   (`.activity-bar__item`, `.tab`, `.terminal-view__toolbar`, `.status-bar`, …) so the mockup DOM
   matches the real DOM. Reproduce structure and theme, not every pixel.
3. **Use real lucide icons.** Add the needed `<symbol>` definitions to the inline sprite (real
   lucide geometry; see [`concept-template.html`](concept-template.html)) and reference them with
   `<svg class="li"><use href="#i-name" /></svg>`. Don't use unicode glyphs.
4. **Mockups are `<section>`s.** Each screen/region is a `.mockup-section` inside the concept's UI
   Interface section — not a separate file.
5. **Annotate.** Mark non-obvious regions with `<span class="callout">A</span>` and add a
   `.legend` explaining each.
6. **Show the state space.** Where it helps, put states side by side with `.states` so a reviewer
   sees empty / loading / active / error at a glance.
7. **Diagrams as text.** Put Mermaid source in `<pre class="mermaid">…</pre>` so it stays editable
   and renders client-side; wrap each in a `.diagram` card with a `.diagram__caption`.

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
  [`../mockups-index.html`](../mockups-index.html), a browsable gallery linking every concept.
- **Screenshots** — `scripts/internal/screenshot-mockup.sh <file.html>` (or `--all`) renders
  mockups to PNG via headless Chrome into `.preview/` (gitignored) for quick visual review and
  fidelity checks.

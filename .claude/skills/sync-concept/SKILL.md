---
name: sync-concept
description: Reconcile a folder-form concept (concept.md + behavior.md + mockups) against the real code. Reads the artifacts and the relevant code surface, reports divergence, and proposes fixes — the concept is the source of truth, so code is fixed by default. Use when the user runs /sync-concept <name>, asks to sync a concept with the code, or check whether a concept and its implementation still agree.
---

# Sync Concept

This skill is the **human-triggered sync step** of termiHub's AI-driven concept workflow
(see `docs/concepts/backlog/ai-driven-concept-workflow.md`). It compares a concept's design
artifacts against the actual implementation and reconciles them.

**Source-of-truth rule (non-negotiable): the concept is authoritative.** When the artifacts and
the code disagree, the default resolution is to **fix the code** to match the concept. The code
only "wins" when a real constraint (platform limit, library behavior, performance reality) means
the design itself was wrong — and then you change the **concept**, not silently the code.

## Input

A concept name, e.g. `/sync-concept broadcast-input`. Resolve it to a folder-form concept under
`docs/concepts/<status>/<name>/`. If the concept is still a single `.md` file (no `mockups/`),
tell the user it has no folder form yet and offer to upgrade it before syncing.

## Procedure

1. **Load the artifacts.** Read `concept.md`, `behavior.md`, every file in `mockups/`, and the
   existing `sync.md` if present. Build a precise list of intended behaviors, states, and layout
   claims. Treat the mockups as layout-altitude (structure/states), not pixel specs.

2. **Locate the code surface.** From the concept's "Preliminary Implementation Details" (the
   New/Modified files table) and by searching the repo, identify the components, stores, hooks,
   Rust modules, and Tauri commands that implement the feature. Read them.

3. **Diff intended vs. actual.** For each artifact claim, classify:
   - **Match** — code implements it.
   - **Code divergence** — code contradicts the concept (default: code is the bug).
   - **Missing** — concept describes it, code lacks it.
   - **Undocumented** — code does something real the concept never mentions.
   - **Design reality** — a constraint makes the concept's intent infeasible/wrong.
   Stay at behavior + layout altitude. Do **not** flag cosmetic CSS differences from a mockup —
   mockups are explicitly approximate.

4. **Write the ledger.** Refresh `sync.md` (see structure below): record the current commit
   (`git rev-parse --short HEAD`), the date, and a dated, itemized divergence list with a
   recommendation per item.

5. **Propose resolutions and let the user decide per item.**
   - Code divergence / Missing → propose **code edits** (default).
   - Undocumented → propose either documenting it in the concept or removing it from code.
   - Design reality → propose a **concept edit** so the concept stays the true picture.
   Apply only what the user confirms. Code changes follow the normal branch + test + PR rules in
   `.claude/CLAUDE.md` — never commit to `main`/`develop`, add/adjust tests for any code fix.

6. **Summarize.** Report counts per category and what was applied vs. deferred.

## `sync.md` structure

```markdown
# Sync Ledger — <Concept Name>

**Last synced:** <date> at commit `<short-sha>`
**Status:** in-sync | diverged

## Open divergences

| # | Artifact claim | Code reality | Type | Recommendation |
| - | -------------- | ------------ | ---- | -------------- |
| 1 | …              | …            | …    | fix code / edit concept |

## Resolved

| Date | # | Resolution |
| ---- | - | ---------- |
```

## Guardrails

- Never auto-apply edits — this skill exists precisely so a human stays in the loop.
- Never resolve a disagreement by silently editing the code to match itself; either fix the code
  to the concept, or change the concept deliberately.
- Keep mockup comparison at structural altitude — color/spacing drift is expected, not a finding.
- If the feature is only partially implemented, that is a normal "Missing" set, not an error.

---
id: TOOL-007
title: No git pre-commit/pre-push hooks — only a Claude-specific autoformat hook
angle: tooling-coverage
severity: medium
category: tooling
is_workaround: false
subsystem: scripts / dev-loop
evidence:
  - .claude/CLAUDE.md:1
  - package.json:7
status: open
---

## What

There is no git hook infrastructure (no `husky`, `lefthook`, `pre-commit`, or
`.git/hooks` scaffold in the repo, no `prepare` script in `package.json`). The only
automatic pre-write quality step is a **`PostToolUse` hook in
`.claude/settings.json`** that runs `scripts/internal/autoformat.sh` — but that fires
only inside a Claude Code session, after Edit/Write, not on `git commit`.

## Why it matters

Any commit made outside a Claude session — a human developer, a different tool, a CI
bot, a contributor — bypasses every local gate: no format, no lint, no commit-message
lint until CI. That pushes all enforcement to CI, wasting cycles on trivially
catchable failures (a slipped prettier format on a new file is explicitly called out
in the coordinator log as a recurring lost-CI-round cause). Commitlint is CI-only
too, so a bad subject case is only caught after push. The autoformat hook also does
not always catch an agent's final edit (per the coordinator notes), so even in-
session coverage is imperfect.

## Evidence

- No `husky`/`lefthook`/`pre-commit` config or `package.json` `prepare` script (the
  scripts block ends at `markdownlint:fix`).
- The autoformat is wired as a Claude `PostToolUse` hook (`.claude/CLAUDE.md` →
  "Auto-Formatting Hook"), i.e. session-scoped, not a git hook.

## Recommendation

Add a lightweight git-hook manager (`lefthook` is fast and language-agnostic; `husky`
+ `lint-staged` is the JS-ecosystem default):

- **pre-commit**: `prettier --check`/`--write` on staged files, `eslint` on staged
  `src/**`, `cargo fmt --check`, `commitlint` on the message.
- **pre-push**: `scripts/check.sh` (or the new `ci-local.sh`, TOOL-006) so a push
  can't send code that fails the cheap gates.

Keep it opt-outable for emergencies but installed by `scripts/setup.sh` so every
checkout gets it, independent of whether Claude is driving.

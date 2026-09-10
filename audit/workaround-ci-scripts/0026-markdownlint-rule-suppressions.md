---
id: WA-CI-026
title: markdownlint disables six default rules (MD013/024/033/034/040/041)
angle: workaround-ci-scripts
severity: low
category: workaround
is_workaround: true
subsystem: .markdownlint.json
evidence:
  - .markdownlint.json
status: open
---

## What
`.markdownlint.json` turns off six default rules: MD013 (line length), MD024 (duplicate
headings), MD033 (inline HTML), MD034 (bare URLs), MD040 (fenced-code language), MD041
(first-line heading). `default: true` keeps the rest.

## Why it matters
These are blanket rule suppressions rather than per-file exceptions. MD033 (inline HTML) is
genuinely needed (the single-file HTML concepts embed HTML in docs), and MD013 line-length is a
common opt-out — but disabling MD040 (code-fence language) and MD034 (bare URLs) globally lowers
doc quality repo-wide with no rationale recorded. There is no comment explaining why each is off.

## Evidence
`"MD013": false, "MD024": false, "MD033": false, "MD034": false, "MD040": false, "MD041": false`.

## Recommendation
Not release-blocking. Document why each rule is disabled; re-enable the ones that aren't
actually needed (MD040 code-fence languages and MD034 bare URLs are cheap wins) and scope MD033
to the concept HTML files if possible. Low.

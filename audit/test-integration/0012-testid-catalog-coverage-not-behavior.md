---
id: TIN-012
title: Testid drift is caught only by a coverage check and the nightly lane — a renamed selector greens per-PR
angle: test-integration
severity: medium
category: test-gap
is_workaround: false
subsystem: tests/system, scripts/build-testid-catalog.py
evidence:
  - scripts/build-testid-catalog.py:30
  - tests/system/tests/test_testid_catalog.py:1
  - .github/workflows/system-integration.yml:9
status: open
---

## What

The `data-testid` catalog is no longer a committed file with a freshness gate;
it is regenerated from `src/**` and "consistency is verified by regenerating
in-memory … asserts known ids are covered" (`test_testid_catalog.py:1-9`). That
per-PR check confirms the **generator still scans** and that a hardcoded known-id
list is present — it does **not** confirm that a bridge verb's selector still
matches a rendered element. The bridge suites that actually select on testids are
`@pytest.mark.integration` and run only nightly (TIN-001).

So if a PR renames/removes a `data-testid` that a system test drives on, per-PR
CI stays green (the catalog regenerates fine, the integration suite is only
collected), and the break surfaces up to ~24h later in the nightly — the exact
"stale-testid rot slipped in unnoticed (#1568)" failure mode the nightly lane's
own header cites (`system-integration.yml:9`).

## Why it matters

- Testid drift between the app and the harness is the #1 historical cause of
  app/harness breakage (three shipped incidents). The current per-PR gate does
  not test the coupling that breaks; it tests that a scanner runs.
- The catalog being uncommitted (a reasonable fix for #1528 branch-churn) removed
  the diff signal without replacing it with a behavior signal on the PR.

## Evidence

- `build-testid-catalog.py:20-45` — catalog is a local, git-ignored, regenerated
  artifact; "CI now regenerates … and verifies coverage."
- `test_testid_catalog.py` — asserts classification + that known ids are covered;
  no app, no selector-match.
- `system-integration.yml:9` — the drift this is meant to prevent only surfaces
  nightly.

## Recommendation

- Add a fast per-PR check that fails when a testid **referenced by the harness**
  disappears from the app: statically diff the set of testids the Python suites
  select on against the regenerated catalog, so a removed/renamed selector reds
  the PR that caused it (no app build needed).
- Combine with the thin per-PR bridge smoke proposed in TIN-001 so the highest-
  traffic selectors are also behavior-checked before merge.

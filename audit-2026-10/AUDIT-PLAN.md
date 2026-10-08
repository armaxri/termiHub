# Audit roster & status — 2026-10

The same 38 expert angles as the first audit ([`audit/AUDIT-PLAN.md`](../audit/AUDIT-PLAN.md)),
audited against `develop` @ `663465d52`. Status: `done` (audited, verified, recorded) or
`not run`. "Raw" is what the auditor reported; "Confirmed" is what survived adversarial
verification.

## Angles

| #   | Slug                    | Expert angle                           | Status |     Raw | Confirmed |     C |     H |       M |       L |     I |
| --- | ----------------------- | -------------------------------------- | ------ | ------: | --------: | ----: | ----: | ------: | ------: | ----: |
| 1   | product-completeness    | Product / feature completeness         | done   |       4 |         4 |     0 |     0 |       1 |       3 |     0 |
| 2   | connection-parity       | Connection-type parity                 | done   |       4 |         4 |     0 |     0 |       3 |       1 |     0 |
| 3   | ux-flows                | UX flows & feedback                    | done   |       7 |         7 |     0 |     0 |       5 |       2 |     0 |
| 4   | state-machine-ux        | State-machine correctness              | done   |       2 |         2 |     0 |     0 |       2 |       0 |     0 |
| 5   | ui-visual               | UI / visual design                     | done   |       6 |         6 |     0 |     0 |       2 |       4 |     0 |
| 6   | accessibility           | Accessibility (WCAG 2.2)               | done   |      12 |        12 |     0 |     0 |      10 |       2 |     0 |
| 7   | architecture-overall    | Architecture                           | done   |       5 |         5 |     0 |     0 |       1 |       4 |     0 |
| 8   | backend-core-rust       | Backend Rust — core                    | done   |       3 |         3 |     0 |     0 |       2 |       1 |     0 |
| 9   | backend-tauri-rust      | Backend Rust — src-tauri               | done   |       2 |         2 |     0 |     1 |       0 |       1 |     0 |
| 10  | agent-protocol          | Remote agent & protocol                | done   |       6 |         6 |     0 |     0 |       4 |       2 |     0 |
| 11  | concurrency-reliability | Concurrency & reliability              | done   |       5 |         5 |     0 |     1 |       3 |       1 |     0 |
| 12  | frontend-state          | Frontend state layer                   | done   |       7 |         7 |     0 |     0 |       2 |       4 |     1 |
| 13  | frontend-components     | Frontend components & services         | done   |       5 |         5 |     0 |     0 |       1 |       4 |     0 |
| 14  | performance             | Performance                            | done   |       7 |         7 |     0 |     1 |       3 |       3 |     0 |
| 15  | security                | Security                               | done   |       8 |         8 |     0 |     0 |       2 |       5 |     1 |
| 16  | supply-chain            | Dependencies & supply-chain            | done   |       6 |         6 |     0 |     0 |       2 |       4 |     0 |
| 17  | test-frontend           | Test coverage — frontend               | done   |       8 |         8 |     0 |     0 |       2 |       6 |     0 |
| 18  | test-backend            | Test coverage — Rust                   | done   |       6 |         6 |     0 |     0 |       2 |       4 |     0 |
| 19  | test-integration        | Integration / E2E / test-bridge        | done   |       7 |         7 |     0 |     0 |       2 |       4 |     1 |
| 20  | test-mocking            | Mocking & test doubles                 | done   |       4 |         4 |     0 |     0 |       2 |       2 |     0 |
| 21  | tooling-coverage        | Tooling & coverage gating              | done   |       4 |         4 |     0 |     0 |       3 |       1 |     0 |
| 22  | packaging-release       | Packaging & release                    | done   |       9 |         9 |     0 |     2 |       3 |       4 |     0 |
| 23  | ci-cd                   | CI/CD pipeline                         | done   |       8 |         8 |     0 |     0 |       6 |       2 |     0 |
| 24  | error-handling          | Error handling & edge cases            | done   |       5 |         5 |     0 |     0 |       1 |       4 |     0 |
| 25  | observability           | Observability & logging                | done   |       7 |         7 |     0 |     0 |       3 |       4 |     0 |
| 26  | persistence-migration   | Persistence & migration                | done   |       7 |         7 |     0 |     0 |       3 |       4 |     0 |
| 27  | i18n                    | Internationalization                   | done   |       5 |         5 |     0 |     0 |       2 |       3 |     0 |
| 28  | docs-accuracy           | Documentation accuracy                 | done   |       9 |         9 |     0 |     0 |       3 |       6 |     0 |
| 29  | marketing               | Marketing & presentation               | done   |       8 |         8 |     0 |     0 |       4 |       4 |     0 |
| 30  | plugin-extensibility    | Plugin & extensibility                 | done   |       6 |         6 |     0 |     1 |       3 |       2 |     0 |
| 31  | workaround-rust         | Workaround hunt — Rust                 | done   |       4 |         4 |     0 |     0 |       1 |       3 |     0 |
| 32  | workaround-frontend     | Workaround hunt — frontend             | done   |       9 |         9 |     0 |     0 |       2 |       6 |     1 |
| 33  | workaround-ci-scripts   | Workaround hunt — CI/scripts           | done   |       6 |         6 |     0 |     0 |       4 |       2 |     0 |
| 34  | deadcode-flags          | Dead-code & feature-flags              | done   |       7 |         7 |     0 |     0 |       3 |       4 |     0 |
| 35  | code-duplication        | Code duplication / core centralization | done   |      10 |        10 |     0 |     0 |       4 |       6 |     0 |
| 36  | ui-shared-foundation    | UI shared foundation                   | done   |      10 |        10 |     0 |     0 |       3 |       7 |     0 |
| 37  | lib-usage-frontend      | Library usage (buy-vs-build) — FE      | done   |       7 |         7 |     0 |     0 |       1 |       3 |     3 |
| 38  | lib-usage-backend       | Library usage (buy-vs-build) — BE      | done   |       5 |         5 |     0 |     0 |       1 |       4 |     0 |
|     | **total**               |                                        |        | **240** |   **240** | **0** | **6** | **101** | **126** | **7** |

Primary scope per angle is unchanged from the first audit's roster.

## Status

**COMPLETE — all 38 angles done; no angle is "not run".** 240 confirmed findings (0
critical, 6 high, 101 medium, 126 low, 7 info); 23 flagged `is_workaround: true`.

- See [`FINDINGS-INDEX.md`](./FINDINGS-INDEX.md) for the per-angle table and the full
  high and medium lists.
- See [`RELEASE-BLOCKERS.md`](./RELEASE-BLOCKERS.md) for the ranked release-gating
  synthesis.
- Run notes: see [`README.md`](./README.md#run-notes) (observability files regenerated
  after a scratch-file collision between two recording agents).

# Audit roster & status

Managed by the audit coordinator. 4 experts run concurrently; a freed slot is refilled
immediately from the queue. Status: `queued` → `running` → `done` (or `blocked`).

## Angles

| # | Slug | Expert angle | Primary scope |
|---|------|--------------|---------------|
| 1 | product-completeness | Product / user expert — feature completeness | whole app, per component |
| 2 | connection-parity | Feature parity across connection types | core/backends/{ssh,docker,ftp,rdp,vnc}, local/serial |
| 3 | ux-flows | UX expert — flows, friction, onboarding, error recovery | src/components, docs |
| 4 | state-machine-ux | State-machine + UX correctness | docs/audits, src/store, src-tauri projections |
| 5 | ui-visual | UI / visual design consistency | src/components, src/themes, src/styles |
| 6 | accessibility | Accessibility (WCAG, keyboard, screen reader) | src/components, src/hooks |
| 7 | architecture-overall | Architecture — layering, boundaries, coupling | whole tree |
| 8 | backend-core-rust | Backend Rust — core crate | core/src |
| 9 | backend-tauri-rust | Backend Rust — src-tauri commands/projections | src-tauri/src |
| 10 | agent-protocol | Remote agent/daemon + protocol | agent/src, docs/remote-protocol.md, core/protocol,ipc |
| 11 | concurrency-reliability | Concurrency / async / reliability / reconnect | core, src-tauri, agent (async paths) |
| 12 | frontend-state | Frontend state — store, slices, hooks | src/store, src/hooks |
| 13 | frontend-components | Frontend — components, services, transport | src/components, src/services |
| 14 | performance | Performance — render, scrollback, memory, bundle | src, core buffer/output |
| 15 | security | Security — creds, host keys, secrets, sandbox, IPC, CSP | src/security, credential, plugin sandbox, capabilities |
| 16 | supply-chain | Dependency / supply-chain / licenses | Cargo.*, package.json, deny.toml, licenses |
| 17 | test-frontend | Test coverage & testability — frontend | src/**/*.test, vitest, coverage/ |
| 18 | test-backend | Test coverage & testability — Rust | core/tests, src-tauri/tests, agent/tests |
| 19 | test-integration | Integration / E2E / test-bridge | tests/, scripts test-system*, docs/test-bridge.md |
| 20 | test-mocking | Mocking / fixtures / determinism / flake | test infra across stack |
| 21 | tooling-coverage | Tooling — missing scripts, full-coverage-before-release | scripts/, package.json, CI |
| 22 | packaging-release | Cross-platform packaging & release | src-tauri bundling, release.yml, scripts |
| 23 | ci-cd | CI/CD pipeline — gates, quarantines, fail-fast | .github/workflows |
| 24 | error-handling | Error handling & edge cases | whole tree (panics/unwrap/error paths) |
| 25 | observability | Observability / logging / diagnostics | logging across stack |
| 26 | persistence-migration | Persistence, config schema, migration, data safety | workspace, config, session_history |
| 27 | i18n | Internationalization / localization readiness | src (strings) |
| 28 | docs-accuracy | Documentation accuracy vs code | docs/, README |
| 29 | marketing | Marketing / presentation | README, docs/concepts, website copy, screenshots |
| 30 | plugin-extensibility | Plugin ecosystem / extensibility | plugin-api, src/plugins, docs/plugin-authoring.md |
| 31 | workaround-rust | Workaround hunter — Rust | core, src-tauri, agent, rdp-sidecar, graft |
| 32 | workaround-frontend | Workaround hunter — TS/frontend | src |
| 33 | workaround-ci-scripts | Workaround hunter — CI / scripts / config | .github, scripts, config files |
| 34 | deadcode-flags | Feature-flag & dead-code / post-inversion residue | src/store, core, feature flags |

## Status

(coordinator updates this as rounds complete)

- Round policy: 4 concurrent, refill on completion.
- All angles start `queued`.

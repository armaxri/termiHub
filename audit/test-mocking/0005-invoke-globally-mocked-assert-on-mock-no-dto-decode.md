---
id: MOCK-005
title: Tauri `invoke` is globally mocked to return undefined; the IPC layer is asserted-on-mock and never decodes a real backend DTO
angle: test-mocking
severity: medium
category: test-gap
is_workaround: false
subsystem: src/services (api.ts) / test infra
evidence:
  - src/test/setup.ts:216
  - src/services/api.test.ts:6
  - src/services/api.test.ts:93
status: open
---

## What
The entire frontend↔backend boundary is the Tauri `invoke()` function, and it is replaced by
a bare `vi.fn()` — globally in `src/test/setup.ts:216` and again per-suite in
`src/services/api.test.ts:6`. Tests then set `mockedInvoke.mockResolvedValue(<a value the test
author typed>)` and assert the **command name and argument object**:

```
# src/services/api.test.ts:93-100
mockedInvoke.mockResolvedValue("session-456");
…
expect(mockedInvoke).toHaveBeenCalledWith("create_connection", { … });
```

The response value is whatever the test writer invented; it is **never decoded or validated
against the real Rust DTO**. There is no contract test that pins the TS wrapper's return type
to the actual serde-serialized shape the Rust command returns.

## Why it matters
- **Backend schema drift is invisible.** If a Rust command renames a field, changes an enum
  tag, or reshapes its return payload, every `api.ts` test stays green because the mock returns
  a hand-typed value that matches the *old* TS type. This is the wire-contract gap TBE-009
  flagged from the Rust side, made concrete on the frontend side: the two ends are each tested
  against their own idea of the DTO, and nothing checks they agree. (Deepens TFE-004.)
- `api.ts` is 2472 LOC of IPC wrappers; roughly half are assert-on-mock and half untested
  (TFE-004). The tested half proves "we called invoke with these args," which is the *request*
  contract only — the *response* contract is completely unmodeled.

## Evidence
- Global mock: `src/test/setup.ts:216` (`vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))`).
- Per-suite mock + assert-on-args pattern: `src/services/api.test.ts:6,22,93-146`.

## Recommendation
Add **wire-contract tests** that generate/derive the response fixtures from the Rust side
rather than hand-typing them: e.g. a `ts-rs`/`schemars`-exported JSON schema (or a golden
fixture captured from a real `cargo test` roundtrip) that the TS decoders are validated
against, failing CI when the shapes diverge. At minimum, decode each `invoke` response through
a `zod` schema in `api.ts` and test that decoder with a fixture that mirrors the real serde
output, so a renamed backend field surfaces as a decode failure instead of silent `undefined`.

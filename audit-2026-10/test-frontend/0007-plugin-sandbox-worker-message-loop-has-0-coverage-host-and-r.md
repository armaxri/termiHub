---
id: TFE2-007
title: "Plugin sandbox worker message loop has 0% coverage; host and runtime are only tested against fakes"
angle: test-frontend
severity: low
category: test-gap
is_workaround: false
subsystem: "src/plugins/sandbox/pluginSandboxWorker.ts"
evidence:
  - src/plugins/sandbox/pluginSandboxWorker.ts:84-96
  - src/plugins/sandbox/pluginSandboxWorker.ts:98-124
  - src/plugins/sandbox/pluginSandboxHost.test.ts:30-56
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

pluginSandboxWorker.ts (the worker-side dispatcher where all frontend plugin JS runs) is at 0/30 lines and 0/9 branches. pluginSandboxHost.test.ts drives the host against a hand-written FakeWorker, and pluginRuntimeCore is tested on its own, so the real worker side of the protocol is never exercised. That includes: loadPlugin turning an importScripts failure into a `loadError` post instead of throwing, the transform reply with transferred buffer, unload, the session hooks, and the initial `ready` post.

## Why it matters

JS plugins are experimental (a maintainer decision), so the blast radius is limited. Still, this is the isolation boundary's message loop: if a broken plugin's load error throws out of the handler, or a transform reply's shape drifts from what the host expects, plugins silently fail or the sandbox wedges, and no test notices because both sides are tested only against their own fakes.

## Evidence

- `src/plugins/sandbox/pluginSandboxWorker.ts:84-96`
- `src/plugins/sandbox/pluginSandboxWorker.ts:98-124`
- `src/plugins/sandbox/pluginSandboxHost.test.ts:30-56`

## Recommendation

Add pluginSandboxWorker.test.ts using the node environment: stub `self` with addEventListener/postMessage/importScripts via vi.stubGlobal, dynamic-import the module, and assert the `ready` post, that a throwing importScripts produces `loadError`, that a transform replies with `changed:true` and transfers the buffer, and the unload/session dispatch. Better still, wire FakeWorker in pluginSandboxHost.test.ts to the real worker module so the two halves are tested together.

## Verification

Confirmed. pluginSandboxWorker.ts has no unit test, and pluginSandboxHost.test.ts uses a FakeWorker. Two things soften it: message shapes come from the shared protocol.ts types, so tsc catches shape drift, and tests/system/termihub_harness/ui/plugins.py has a sandbox-probe plugin that exercises the real worker in the system lane, though not per-PR. JS plugins are also experimental. Low is right, bordering on info.

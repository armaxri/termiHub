/**
 * #5156: a typed secret is written only once its tab's session is established;
 * every other outcome discards it unsaved.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  authFailed,
  connected,
  connecting,
  failed,
  flushSessionRegion,
  installSessionLifecycleHarness,
} from "@/test/sessionLifecycleRegionTestHarness";
import { ensureSessionSubscribed } from "@/store/sessionBridge";
import { persistSecretOnceConnected } from "./persistSecretOnceConnected";

const harness = installSessionLifecycleHarness();
const TAB = "tab-persist";

/** Start the wait with the region already subscribed. */
async function start(persist: () => Promise<void>, timeoutMs?: number) {
  await ensureSessionSubscribed();
  await flushSessionRegion();
  const outcome = persistSecretOnceConnected(TAB, persist, timeoutMs ? { timeoutMs } : {});
  await flushSessionRegion();
  // Wrapped so awaiting `start` does not also await the outcome.
  return { outcome };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("persistSecretOnceConnected (#5156)", () => {
  it("persists once a fresh tab's session is established", async () => {
    const persist = vi.fn(() => Promise.resolve());
    const { outcome } = await start(persist);
    harness.transport.setSession(TAB, connecting());
    await flushSessionRegion();
    expect(persist).not.toHaveBeenCalled();

    harness.transport.setSession(TAB, connected());
    await expect(outcome).resolves.toBe("persisted");
    expect(persist).toHaveBeenCalledOnce();
  });

  it("discards the secret when the server rejects it (a typo)", async () => {
    const persist = vi.fn(() => Promise.resolve());
    const { outcome } = await start(persist);
    harness.transport.setSession(TAB, connecting());
    harness.transport.setSession(TAB, authFailed());
    await expect(outcome).resolves.toBe("discarded");
    expect(persist).not.toHaveBeenCalled();
  });

  it("discards the secret when a fresh tab fails without a visible connecting step", async () => {
    const persist = vi.fn(() => Promise.resolve());
    const { outcome } = await start(persist);
    harness.transport.setSession(TAB, failed("unreachable"));
    await expect(outcome).resolves.toBe("discarded");
    expect(persist).not.toHaveBeenCalled();
  });

  it("discards the secret when the tab closes mid-connect", async () => {
    const persist = vi.fn(() => Promise.resolve());
    const { outcome } = await start(persist);
    harness.transport.setSession(TAB, connecting());
    await flushSessionRegion();
    harness.transport.clearSession(TAB);
    await expect(outcome).resolves.toBe("discarded");
    expect(persist).not.toHaveBeenCalled();
  });

  it("ignores the stale rejection of a re-entry tab until the new attempt settles", async () => {
    // The tab sits in `authFailed` from the rejected secret before the re-entry.
    await ensureSessionSubscribed();
    harness.transport.setSession(TAB, authFailed());
    await flushSessionRegion();
    const persist = vi.fn(() => Promise.resolve());
    const outcome = persistSecretOnceConnected(TAB, persist);
    await flushSessionRegion();
    // A re-emitted stale rejection is not this attempt's outcome.
    harness.transport.setSession(TAB, authFailed());
    await flushSessionRegion();
    expect(persist).not.toHaveBeenCalled();

    harness.transport.setSession(TAB, connecting());
    harness.transport.setSession(TAB, connected());
    await expect(outcome).resolves.toBe("persisted");
    expect(persist).toHaveBeenCalledOnce();
  });

  it("discards the secret when a re-entry's new attempt is rejected again", async () => {
    await ensureSessionSubscribed();
    harness.transport.setSession(TAB, authFailed());
    await flushSessionRegion();
    const persist = vi.fn(() => Promise.resolve());
    const outcome = persistSecretOnceConnected(TAB, persist);
    harness.transport.setSession(TAB, connecting());
    harness.transport.setSession(TAB, authFailed());
    await expect(outcome).resolves.toBe("discarded");
    expect(persist).not.toHaveBeenCalled();
  });

  it("reports a write that fails after connecting", async () => {
    const persist = vi.fn(() => Promise.reject(new Error("keychain locked")));
    const { outcome } = await start(persist);
    harness.transport.setSession(TAB, connected());
    await expect(outcome).resolves.toBe("failed");
  });

  it("discards the secret when the connect never settles", async () => {
    const persist = vi.fn(() => Promise.resolve());
    const { outcome } = await start(persist, 50);
    harness.transport.setSession(TAB, connecting());
    await expect(outcome).resolves.toBe("discarded");
    // A late success after the timeout writes nothing.
    harness.transport.setSession(TAB, connected());
    await flushSessionRegion();
    expect(persist).not.toHaveBeenCalled();
  });
});

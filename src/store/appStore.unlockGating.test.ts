import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(),
}));

import { useAppStore } from "./appStore";

/**
 * G1 — every requestUnlock() promise must settle exactly once on any dialog exit,
 * including the fragile paths: wrong-password-then-dismiss and two concurrent
 * unlock requests. A promise that never resolves wedges the awaiting connect forever.
 */
describe("appStore unlock gating — requestUnlock() settlement (G1)", () => {
  beforeEach(() => {
    useAppStore.setState({
      unlockDialogOpen: false,
      unlockResolvers: [],
    });
  });

  it("resolves the pending promise as false when the dialog is dismissed (wrong password → close)", async () => {
    const promise = useAppStore.getState().requestUnlock();
    expect(useAppStore.getState().unlockDialogOpen).toBe(true);

    // User typed a wrong password (inline error, dialog stays open), then closed
    // it via the X / overlay / Esc — all route through setUnlockDialogOpen(false).
    useAppStore.getState().setUnlockDialogOpen(false);

    await expect(promise).resolves.toBe(false);
  });

  it("resolves the pending promise as true when the backend reports unlocked", async () => {
    const promise = useAppStore.getState().requestUnlock();

    // The credential-store-unlocked event handler calls resolveUnlock(true).
    useAppStore.getState().resolveUnlock(true);

    await expect(promise).resolves.toBe(true);
  });

  it("does not leave a stale resolver after settlement (idempotent resolveUnlock)", async () => {
    const promise = useAppStore.getState().requestUnlock();
    useAppStore.getState().resolveUnlock(true);
    await expect(promise).resolves.toBe(true);
    expect(useAppStore.getState().unlockResolvers).toHaveLength(0);

    // A second resolveUnlock() must be a harmless no-op.
    expect(() => useAppStore.getState().resolveUnlock(false)).not.toThrow();
  });

  it("settles BOTH promises when two connect flows request unlock concurrently", async () => {
    // Two connects both see a locked store and both await requestUnlock().
    const first = useAppStore.getState().requestUnlock();
    const second = useAppStore.getState().requestUnlock();

    // A single unlock (or a single dismissal) must settle every awaiting caller —
    // otherwise the first connect wedges forever (the G1 hang).
    useAppStore.getState().resolveUnlock(true);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(useAppStore.getState().unlockResolvers).toHaveLength(0);
  });

  it("settles both concurrent promises when the dialog is dismissed", async () => {
    const first = useAppStore.getState().requestUnlock();
    const second = useAppStore.getState().requestUnlock();

    useAppStore.getState().setUnlockDialogOpen(false);

    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
  });
});

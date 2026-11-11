import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { create, type StateCreator } from "zustand";

import type { CredentialStoreStatusInfo } from "@/types/credential";
import { onFrontendLog } from "@/utils/frontendLog";

vi.mock("@/services/api", () => ({
  getCredentialStoreStatus: vi.fn(),
}));

import { getCredentialStoreStatus } from "@/services/api";
import { createCredentialStoreSlice, type CredentialStoreSlice } from "./credentialStoreSlice";

const mockedStatus = vi.mocked(getCredentialStoreStatus);

// The slice only depends on `@/services/api` (mocked) and `frontendLog`; its
// `get()` cross-references (`resolveUnlock`, `unlockResolvers`) all live within
// the slice, so a standalone store is a faithful, isolated driver.
const makeStore = () =>
  create<CredentialStoreSlice>()(
    createCredentialStoreSlice as unknown as StateCreator<CredentialStoreSlice>
  );

const status = (unlocked: boolean): CredentialStoreStatusInfo => ({
  mode: "master_password",
  status: unlocked ? "unlocked" : "locked",
});

/** Capture frontendLog messages emitted during `fn`. */
async function captureLogs(fn: () => Promise<void> | void): Promise<string[]> {
  const messages: string[] = [];
  const off = onFrontendLog((entry) => messages.push(entry.message));
  try {
    await fn();
  } finally {
    off();
  }
  return messages;
}

describe("credentialStoreSlice", () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults status to null and the unlock dialog closed", () => {
    expect(store.getState().credentialStoreStatus).toBeNull();
    expect(store.getState().unlockDialogOpen).toBe(false);
    expect(store.getState().unlockResolvers).toEqual([]);
  });

  it("setCredentialStoreStatus stores the snapshot", () => {
    store.getState().setCredentialStoreStatus(status(true));
    expect(store.getState().credentialStoreStatus).toEqual(status(true));
  });

  it("loadCredentialStoreStatus fetches and stores the status", async () => {
    mockedStatus.mockResolvedValueOnce(status(false));
    await store.getState().loadCredentialStoreStatus();
    expect(store.getState().credentialStoreStatus).toEqual(status(false));
  });

  it("loadCredentialStoreStatus swallows an Error rejection and logs its message", async () => {
    mockedStatus.mockRejectedValueOnce(new Error("backend down"));
    const logs = await captureLogs(() => store.getState().loadCredentialStoreStatus());
    // Status stays null; the error is logged, not thrown.
    expect(store.getState().credentialStoreStatus).toBeNull();
    expect(logs.some((m) => m.includes("backend down"))).toBe(true);
  });

  it("loadCredentialStoreStatus stringifies a non-Error rejection (String(err) branch)", async () => {
    mockedStatus.mockRejectedValueOnce("plain string failure");
    const logs = await captureLogs(() => store.getState().loadCredentialStoreStatus());
    expect(store.getState().credentialStoreStatus).toBeNull();
    expect(logs.some((m) => m.includes("plain string failure"))).toBe(true);
  });

  it("requestUnlock opens the dialog and settles all waiters on resolveUnlock (G1)", async () => {
    const first = store.getState().requestUnlock();
    const second = store.getState().requestUnlock();
    expect(store.getState().unlockDialogOpen).toBe(true);
    expect(store.getState().unlockResolvers).toHaveLength(2);

    store.getState().resolveUnlock(true);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    // Cleared after settling so a re-entrant resolveUnlock is a no-op.
    expect(store.getState().unlockResolvers).toEqual([]);
  });

  it("resolveUnlock with no pending waiters is a harmless no-op", () => {
    expect(() => store.getState().resolveUnlock(false)).not.toThrow();
    expect(store.getState().unlockResolvers).toEqual([]);
  });

  it("setUnlockDialogOpen closing an open dialog cancels pending requests with false", async () => {
    const pending = store.getState().requestUnlock();
    expect(store.getState().unlockDialogOpen).toBe(true);
    // Closing (prevOpen && !open) triggers resolveUnlock(false).
    store.getState().setUnlockDialogOpen(false);
    await expect(pending).resolves.toBe(false);
    expect(store.getState().unlockDialogOpen).toBe(false);
  });

  it("setUnlockDialogOpen opening does not settle waiters", () => {
    const resolve = vi.fn();
    store.setState({ unlockResolvers: [resolve] });
    store.getState().setUnlockDialogOpen(true);
    expect(resolve).not.toHaveBeenCalled();
    expect(store.getState().unlockResolvers).toEqual([resolve]);
  });
});

describe("credentialStoreSlice — connect fall-through (#5188)", () => {
  it("offers the fall-through only for a connectFallback request", () => {
    const store = makeStore();
    void store.getState().requestUnlockOutcome();
    expect(store.getState().unlockConnectFallback).toBe(false);
    void store.getState().requestUnlockOutcome({ connectFallback: true });
    expect(store.getState().unlockConnectFallback).toBe(true);
  });

  it("skipUnlock settles every waiter 'skipped', closes the dialog and clears the offer", async () => {
    const store = makeStore();
    const outcome = store.getState().requestUnlockOutcome({ connectFallback: true });
    const plain = store.getState().requestUnlock();
    store.getState().skipUnlock();
    await expect(outcome).resolves.toBe("skipped");
    // A boolean waiter (e.g. a Settings action) reads the fall-through as a cancel.
    await expect(plain).resolves.toBe(false);
    expect(store.getState().unlockDialogOpen).toBe(false);
    expect(store.getState().unlockConnectFallback).toBe(false);
    expect(store.getState().unlockResolvers).toEqual([]);
  });

  it("closing the dialog settles 'canceled'; an unlock settles 'unlocked'", async () => {
    const store = makeStore();
    const canceled = store.getState().requestUnlockOutcome({ connectFallback: true });
    store.getState().setUnlockDialogOpen(false);
    await expect(canceled).resolves.toBe("canceled");

    const unlocked = store.getState().requestUnlockOutcome({ connectFallback: true });
    store.getState().resolveUnlock(true);
    await expect(unlocked).resolves.toBe("unlocked");
  });

  describe("first-use storage chooser (#5187)", () => {
    let store: ReturnType<typeof makeStore>;
    beforeEach(() => {
      store = makeStore();
    });

    it("starts closed with nothing pending", () => {
      expect(store.getState().storageChooserOpen).toBe(false);
      expect(store.getState().storageChooserResolvers).toEqual([]);
    });

    it("opens on request and settles every waiter on the single exit", async () => {
      const first = store.getState().requestStorageChoice();
      const second = store.getState().requestStorageChoice();
      expect(store.getState().storageChooserOpen).toBe(true);
      expect(store.getState().storageChooserResolvers).toHaveLength(2);

      store.getState().resolveStorageChoice("os_keychain");

      await expect(Promise.all([first, second])).resolves.toEqual(["os_keychain", "os_keychain"]);
      expect(store.getState().storageChooserOpen).toBe(false);
      expect(store.getState().storageChooserResolvers).toEqual([]);
    });

    it("settles a cancel as canceled and ignores a second settle", async () => {
      const pending = store.getState().requestStorageChoice();
      store.getState().resolveStorageChoice("canceled");
      store.getState().resolveStorageChoice("os_keychain");
      await expect(pending).resolves.toBe("canceled");
    });
  });
});

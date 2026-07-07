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

import { useAppStore } from "@/store/appStore";
import { ensureCredentialStoreUnlocked } from "./ensureCredentialStoreUnlocked";

/**
 * The shared unlock gate that every connect path calls before resolving a stored
 * credential. Collapses the duplicated `needsStoredCredential + locked + requestUnlock`
 * pattern (G1/G2/G3) into one helper.
 */
describe("ensureCredentialStoreUnlocked", () => {
  beforeEach(() => {
    useAppStore.setState({
      credentialStoreStatus: null,
      unlockDialogOpen: false,
    });
  });

  it("prompts for unlock and returns true when a password auth hits a locked master-password store", async () => {
    const requestUnlock = vi.fn().mockResolvedValue(true);
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "locked" },
      requestUnlock,
    });

    const proceed = await ensureCredentialStoreUnlocked({ authMethod: "password" });

    expect(requestUnlock).toHaveBeenCalledTimes(1);
    expect(proceed).toBe(true);
  });

  it("returns false (abort) when the user dismisses the unlock dialog", async () => {
    const requestUnlock = vi.fn().mockResolvedValue(false);
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "locked" },
      requestUnlock,
    });

    const proceed = await ensureCredentialStoreUnlocked({ authMethod: "password" });

    expect(requestUnlock).toHaveBeenCalledTimes(1);
    expect(proceed).toBe(false);
  });

  it("does not prompt when the store is already unlocked", async () => {
    const requestUnlock = vi.fn().mockResolvedValue(true);
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
      requestUnlock,
    });

    const proceed = await ensureCredentialStoreUnlocked({ authMethod: "password" });

    expect(requestUnlock).not.toHaveBeenCalled();
    expect(proceed).toBe(true);
  });

  it("does not prompt when the mode is not master_password (os_keychain / none)", async () => {
    const requestUnlock = vi.fn().mockResolvedValue(true);
    useAppStore.setState({
      credentialStoreStatus: { mode: "os_keychain", status: "unlocked" },
      requestUnlock,
    });

    const proceed = await ensureCredentialStoreUnlocked({ authMethod: "password" });

    expect(requestUnlock).not.toHaveBeenCalled();
    expect(proceed).toBe(true);
  });

  it("does not prompt when the auth method does not need a stored credential", async () => {
    const requestUnlock = vi.fn().mockResolvedValue(true);
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "locked" },
      requestUnlock,
    });

    // agent auth needs no stored secret.
    const proceedAgent = await ensureCredentialStoreUnlocked({ authMethod: "agent" });
    expect(proceedAgent).toBe(true);

    // key auth without savePassword needs no stored secret.
    const proceedKey = await ensureCredentialStoreUnlocked({
      authMethod: "key",
      savePassword: false,
    });
    expect(proceedKey).toBe(true);

    expect(requestUnlock).not.toHaveBeenCalled();
  });

  it("prompts for key auth WITH savePassword when the store is locked", async () => {
    const requestUnlock = vi.fn().mockResolvedValue(true);
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "locked" },
      requestUnlock,
    });

    const proceed = await ensureCredentialStoreUnlocked({
      authMethod: "key",
      savePassword: true,
    });

    expect(requestUnlock).toHaveBeenCalledTimes(1);
    expect(proceed).toBe(true);
  });
});

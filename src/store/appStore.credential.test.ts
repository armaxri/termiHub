import { describe, it, expect, vi, beforeEach } from "vitest";
import { CredentialStoreStatusInfo } from "@/types/credential";

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

// Import after mock setup
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "./appStore";

const mockedInvoke = vi.mocked(invoke);

describe("appStore credential store state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the store to initial state
    useAppStore.setState({
      credentialStoreStatus: null,
      unlockDialogOpen: false,
      masterPasswordSetupOpen: false,
      masterPasswordSetupMode: "setup",
    });
  });

  it("credentialStoreStatus is initially null", () => {
    expect(useAppStore.getState().credentialStoreStatus).toBeNull();
  });

  it("setCredentialStoreStatus updates the state", () => {
    const status: CredentialStoreStatusInfo = {
      mode: "keychain",
      status: "unlocked",
      keychainAvailable: true,
    };

    useAppStore.getState().setCredentialStoreStatus(status);

    expect(useAppStore.getState().credentialStoreStatus).toEqual(status);
  });

  it("setCredentialStoreStatus can update to different modes", () => {
    const keychainStatus: CredentialStoreStatusInfo = {
      mode: "keychain",
      status: "unlocked",
      keychainAvailable: true,
    };
    useAppStore.getState().setCredentialStoreStatus(keychainStatus);
    expect(useAppStore.getState().credentialStoreStatus?.mode).toBe("keychain");

    const masterStatus: CredentialStoreStatusInfo = {
      mode: "master_password",
      status: "locked",
      keychainAvailable: true,
    };
    useAppStore.getState().setCredentialStoreStatus(masterStatus);
    expect(useAppStore.getState().credentialStoreStatus?.mode).toBe("master_password");
    expect(useAppStore.getState().credentialStoreStatus?.status).toBe("locked");
  });

  it("loadCredentialStoreStatus fetches from backend and updates state", async () => {
    const status: CredentialStoreStatusInfo = {
      mode: "master_password",
      status: "unlocked",
      keychainAvailable: false,
    };
    mockedInvoke.mockResolvedValueOnce(status);

    await useAppStore.getState().loadCredentialStoreStatus();

    expect(mockedInvoke).toHaveBeenCalledWith("get_credential_store_status");
    expect(useAppStore.getState().credentialStoreStatus).toEqual(status);
  });

  it("loadCredentialStoreStatus handles errors gracefully", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedInvoke.mockRejectedValueOnce(new Error("Backend error"));

    await useAppStore.getState().loadCredentialStoreStatus();

    expect(useAppStore.getState().credentialStoreStatus).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      "Failed to load credential store status:",
      expect.any(Error)
    );
    consoleSpy.mockRestore();
  });

  // Unlock dialog state
  it("unlockDialogOpen is initially false", () => {
    expect(useAppStore.getState().unlockDialogOpen).toBe(false);
  });

  it("setUnlockDialogOpen updates the state", () => {
    useAppStore.getState().setUnlockDialogOpen(true);
    expect(useAppStore.getState().unlockDialogOpen).toBe(true);

    useAppStore.getState().setUnlockDialogOpen(false);
    expect(useAppStore.getState().unlockDialogOpen).toBe(false);
  });

  // Master password setup state
  it("masterPasswordSetupOpen is initially false", () => {
    expect(useAppStore.getState().masterPasswordSetupOpen).toBe(false);
  });

  it("masterPasswordSetupMode is initially setup", () => {
    expect(useAppStore.getState().masterPasswordSetupMode).toBe("setup");
  });

  it("openMasterPasswordSetup sets open and mode", () => {
    useAppStore.getState().openMasterPasswordSetup("change");
    expect(useAppStore.getState().masterPasswordSetupOpen).toBe(true);
    expect(useAppStore.getState().masterPasswordSetupMode).toBe("change");

    useAppStore.getState().closeMasterPasswordSetup();
    useAppStore.getState().openMasterPasswordSetup("setup");
    expect(useAppStore.getState().masterPasswordSetupOpen).toBe(true);
    expect(useAppStore.getState().masterPasswordSetupMode).toBe("setup");
  });

  it("closeMasterPasswordSetup sets open to false", () => {
    useAppStore.getState().openMasterPasswordSetup("change");
    expect(useAppStore.getState().masterPasswordSetupOpen).toBe(true);

    useAppStore.getState().closeMasterPasswordSetup();
    expect(useAppStore.getState().masterPasswordSetupOpen).toBe(false);
  });
});

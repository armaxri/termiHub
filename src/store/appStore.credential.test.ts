import { describe, it, expect, vi, beforeEach } from "vitest";
import { CredentialStoreStatusInfo } from "@/types/credential";
import type { SavedConnection } from "@/types/connection";
import type { WorkspaceDefinition } from "@/types/workspace";

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
      mode: "master_password",
      status: "unlocked",
    };

    useAppStore.getState().setCredentialStoreStatus(status);

    expect(useAppStore.getState().credentialStoreStatus).toEqual(status);
  });

  it("setCredentialStoreStatus can update to different modes", () => {
    const noneStatus: CredentialStoreStatusInfo = {
      mode: "none",
      status: "unavailable",
    };
    useAppStore.getState().setCredentialStoreStatus(noneStatus);
    expect(useAppStore.getState().credentialStoreStatus?.mode).toBe("none");

    const masterStatus: CredentialStoreStatusInfo = {
      mode: "master_password",
      status: "locked",
    };
    useAppStore.getState().setCredentialStoreStatus(masterStatus);
    expect(useAppStore.getState().credentialStoreStatus?.mode).toBe("master_password");
    expect(useAppStore.getState().credentialStoreStatus?.status).toBe("locked");
  });

  it("loadCredentialStoreStatus fetches from backend and updates state", async () => {
    const status: CredentialStoreStatusInfo = {
      mode: "master_password",
      status: "unlocked",
    };
    mockedInvoke.mockResolvedValueOnce(status);

    await useAppStore.getState().loadCredentialStoreStatus();

    expect(mockedInvoke).toHaveBeenCalledWith("get_credential_store_status");
    expect(useAppStore.getState().credentialStoreStatus).toEqual(status);
  });

  it("loadCredentialStoreStatus does NOT open the unlock dialog when store is locked (on-demand only)", async () => {
    // Regression test: startup must not prompt for master password unprompted.
    // The dialog should only open when credentials are actually needed.
    const lockedStatus: CredentialStoreStatusInfo = {
      mode: "master_password",
      status: "locked",
    };
    mockedInvoke.mockResolvedValueOnce(lockedStatus);

    await useAppStore.getState().loadCredentialStoreStatus();

    expect(useAppStore.getState().credentialStoreStatus).toEqual(lockedStatus);
    expect(useAppStore.getState().unlockDialogOpen).toBe(false);
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

describe("launchWorkspace — credential store pre-unlock", () => {
  const sshConnection: SavedConnection = {
    id: "conn-ssh-1",
    name: "SSH Server",
    config: {
      type: "ssh",
      config: {
        host: "example.com",
        port: 22,
        username: "user",
        authMethod: "password",
        savePassword: true,
      },
    },
    folderId: null,
  };

  const workspaceWithSsh: WorkspaceDefinition = {
    id: "ws-1",
    name: "Dev Workspace",
    tabGroups: [
      {
        name: "Main",
        layout: {
          type: "leaf",
          tabs: [{ connectionRef: "conn-ssh-1" }],
        },
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({
      credentialStoreStatus: null,
      unlockDialogOpen: false,
      activeWorkspaceName: null,
      connections: [],
    });
  });

  it("prompts for unlock before opening tabs when store is locked and workspace has a password connection", async () => {
    mockedInvoke.mockResolvedValueOnce(workspaceWithSsh);
    const mockRequestUnlock = vi.fn().mockResolvedValue(true);
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "locked" },
      connections: [sshConnection],
      requestUnlock: mockRequestUnlock,
    });

    await useAppStore.getState().launchWorkspace("ws-1");

    expect(mockRequestUnlock).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().activeWorkspaceName).toBe("Dev Workspace");
  });

  it("aborts workspace launch without opening any tabs if unlock is dismissed", async () => {
    mockedInvoke.mockResolvedValueOnce(workspaceWithSsh);
    const mockRequestUnlock = vi.fn().mockResolvedValue(false);
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "locked" },
      connections: [sshConnection],
      requestUnlock: mockRequestUnlock,
    });

    await useAppStore.getState().launchWorkspace("ws-1");

    expect(mockRequestUnlock).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().activeWorkspaceName).toBeNull();
  });

  it("does not prompt for unlock when credential store is already unlocked", async () => {
    mockedInvoke.mockResolvedValueOnce(workspaceWithSsh);
    const mockRequestUnlock = vi.fn().mockResolvedValue(true);
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
      connections: [sshConnection],
      requestUnlock: mockRequestUnlock,
    });

    await useAppStore.getState().launchWorkspace("ws-1");

    expect(mockRequestUnlock).not.toHaveBeenCalled();
    expect(useAppStore.getState().activeWorkspaceName).toBe("Dev Workspace");
  });

  it("does not prompt for unlock when no connections in the workspace need stored credentials", async () => {
    const localConnection: SavedConnection = {
      id: "conn-local-1",
      name: "Local Shell",
      config: { type: "local", config: { shell: "bash" } },
      folderId: null,
    };
    const workspaceWithLocal: WorkspaceDefinition = {
      id: "ws-2",
      name: "Local Workspace",
      tabGroups: [
        {
          name: "Main",
          layout: {
            type: "leaf",
            tabs: [{ connectionRef: "conn-local-1" }],
          },
        },
      ],
    };
    mockedInvoke.mockResolvedValueOnce(workspaceWithLocal);
    const mockRequestUnlock = vi.fn().mockResolvedValue(true);
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "locked" },
      connections: [localConnection],
      requestUnlock: mockRequestUnlock,
    });

    await useAppStore.getState().launchWorkspace("ws-2");

    expect(mockRequestUnlock).not.toHaveBeenCalled();
    expect(useAppStore.getState().activeWorkspaceName).toBe("Local Workspace");
  });

  it("injects resolved password into the tab config so Terminal.tsx can connect without prompting", async () => {
    // First invoke: load_workspace; second: resolve_credential returns the stored password
    mockedInvoke.mockResolvedValueOnce(workspaceWithSsh);
    mockedInvoke.mockResolvedValueOnce("stored-secret");
    const mockRequestUnlock = vi.fn().mockResolvedValue(true);
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
      connections: [sshConnection],
      requestUnlock: mockRequestUnlock,
    });

    await useAppStore.getState().launchWorkspace("ws-1");

    const rootPanel = useAppStore.getState().rootPanel;
    expect(rootPanel.type).toBe("leaf");
    if (rootPanel.type === "leaf") {
      const cfg = rootPanel.tabs[0].config.config as Record<string, unknown>;
      expect(cfg.password).toBe("stored-secret");
    }
  });

  it("also prompts for unlock when connection uses SSH key with savePassword=true", async () => {
    const sshKeyConnection: SavedConnection = {
      id: "conn-key-1",
      name: "SSH Key Server",
      config: {
        type: "ssh",
        config: {
          host: "key.example.com",
          port: 22,
          username: "user",
          authMethod: "key",
          savePassword: true,
        },
      },
      folderId: null,
    };
    const workspaceWithKey: WorkspaceDefinition = {
      id: "ws-3",
      name: "Key Workspace",
      tabGroups: [
        {
          name: "Main",
          layout: {
            type: "leaf",
            tabs: [{ connectionRef: "conn-key-1" }],
          },
        },
      ],
    };
    mockedInvoke.mockResolvedValueOnce(workspaceWithKey);
    const mockRequestUnlock = vi.fn().mockResolvedValue(true);
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "locked" },
      connections: [sshKeyConnection],
      requestUnlock: mockRequestUnlock,
    });

    await useAppStore.getState().launchWorkspace("ws-3");

    expect(mockRequestUnlock).toHaveBeenCalledTimes(1);
  });
});

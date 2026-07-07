import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { CredentialStoreIndicator } from "./CredentialStoreIndicator";
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

vi.mock("@/services/api", () => ({
  lockCredentialStore: vi.fn(),
}));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: { success: vi.fn(), error: vi.fn() },
  };
});

import { lockCredentialStore } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import { toast } from "@/components/ui";

const mockedLock = vi.mocked(lockCredentialStore);
const mockedToast = vi.mocked(toast);

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

describe("CredentialStoreIndicator", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("returns null when status is null", () => {
    useAppStore.setState({ credentialStoreStatus: null });

    act(() => {
      root.render(<CredentialStoreIndicator />);
    });

    expect(query("credential-store-indicator")).toBeNull();
  });

  it("returns null for none mode", () => {
    const status: CredentialStoreStatusInfo = {
      mode: "none",
      status: "unavailable",
    };
    useAppStore.setState({ credentialStoreStatus: status });

    act(() => {
      root.render(<CredentialStoreIndicator />);
    });

    expect(query("credential-store-indicator")).toBeNull();
  });

  it("renders locked state for master_password mode", () => {
    const status: CredentialStoreStatusInfo = {
      mode: "master_password",
      status: "locked",
    };
    useAppStore.setState({ credentialStoreStatus: status });

    act(() => {
      root.render(<CredentialStoreIndicator />);
    });

    const indicator = query("credential-store-indicator");
    expect(indicator).not.toBeNull();
    expect(indicator!.textContent).toContain("Locked");
  });

  it("renders unlocked state for master_password mode", () => {
    const status: CredentialStoreStatusInfo = {
      mode: "master_password",
      status: "unlocked",
    };
    useAppStore.setState({ credentialStoreStatus: status });

    act(() => {
      root.render(<CredentialStoreIndicator />);
    });

    const indicator = query("credential-store-indicator");
    expect(indicator).not.toBeNull();
    expect(indicator!.textContent).toContain("Unlocked");
  });

  it("renders a keychain indicator for os_keychain mode", () => {
    const status: CredentialStoreStatusInfo = {
      mode: "os_keychain",
      status: "unlocked",
    };
    useAppStore.setState({ credentialStoreStatus: status });

    act(() => {
      root.render(<CredentialStoreIndicator />);
    });

    const indicator = query("credential-store-indicator");
    expect(indicator).not.toBeNull();
    expect(indicator!.textContent).toContain("Keychain");
  });

  it("clicking os_keychain indicator does not lock or open the unlock dialog", () => {
    const status: CredentialStoreStatusInfo = {
      mode: "os_keychain",
      status: "unlocked",
    };
    useAppStore.setState({ credentialStoreStatus: status, unlockDialogOpen: false });

    act(() => {
      root.render(<CredentialStoreIndicator />);
    });

    const indicator = query("credential-store-indicator") as HTMLButtonElement;
    act(() => {
      indicator.click();
    });

    expect(useAppStore.getState().unlockDialogOpen).toBe(false);
    expect(mockedLock).not.toHaveBeenCalled();
  });

  it("clicking locked indicator opens unlock dialog", () => {
    const status: CredentialStoreStatusInfo = {
      mode: "master_password",
      status: "locked",
    };
    useAppStore.setState({ credentialStoreStatus: status, unlockDialogOpen: false });

    act(() => {
      root.render(<CredentialStoreIndicator />);
    });

    const indicator = query("credential-store-indicator") as HTMLButtonElement;
    act(() => {
      indicator.click();
    });

    expect(useAppStore.getState().unlockDialogOpen).toBe(true);
  });

  it("clicking unlocked indicator calls lockCredentialStore", async () => {
    mockedLock.mockResolvedValueOnce(undefined);
    const status: CredentialStoreStatusInfo = {
      mode: "master_password",
      status: "unlocked",
    };
    useAppStore.setState({ credentialStoreStatus: status });

    act(() => {
      root.render(<CredentialStoreIndicator />);
    });

    const indicator = query("credential-store-indicator") as HTMLButtonElement;
    await act(async () => {
      indicator.click();
    });

    expect(mockedLock).toHaveBeenCalled();
  });

  it("shows a success toast after locking the store", async () => {
    mockedLock.mockResolvedValueOnce(undefined);
    const status: CredentialStoreStatusInfo = {
      mode: "master_password",
      status: "unlocked",
    };
    useAppStore.setState({ credentialStoreStatus: status });

    act(() => {
      root.render(<CredentialStoreIndicator />);
    });

    const indicator = query("credential-store-indicator") as HTMLButtonElement;
    await act(async () => {
      indicator.click();
    });

    expect(mockedToast.success).toHaveBeenCalledWith(expect.stringContaining("locked"));
  });

  it("shows an error toast when locking fails", async () => {
    mockedLock.mockRejectedValueOnce(new Error("boom"));
    const status: CredentialStoreStatusInfo = {
      mode: "master_password",
      status: "unlocked",
    };
    useAppStore.setState({ credentialStoreStatus: status });

    act(() => {
      root.render(<CredentialStoreIndicator />);
    });

    const indicator = query("credential-store-indicator") as HTMLButtonElement;
    await act(async () => {
      indicator.click();
    });

    expect(mockedToast.error).toHaveBeenCalledWith(expect.stringContaining("lock"));
    expect(mockedToast.success).not.toHaveBeenCalled();
  });
});

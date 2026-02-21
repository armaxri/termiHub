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

import { lockCredentialStore } from "@/services/api";
import { useAppStore } from "@/store/appStore";

const mockedLock = vi.mocked(lockCredentialStore);

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

  it("returns null for keychain mode", () => {
    const status: CredentialStoreStatusInfo = {
      mode: "keychain",
      status: "unlocked",
      keychainAvailable: true,
    };
    useAppStore.setState({ credentialStoreStatus: status });

    act(() => {
      root.render(<CredentialStoreIndicator />);
    });

    expect(query("credential-store-indicator")).toBeNull();
  });

  it("returns null for none mode", () => {
    const status: CredentialStoreStatusInfo = {
      mode: "none",
      status: "unavailable",
      keychainAvailable: false,
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
      keychainAvailable: false,
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
      keychainAvailable: false,
    };
    useAppStore.setState({ credentialStoreStatus: status });

    act(() => {
      root.render(<CredentialStoreIndicator />);
    });

    const indicator = query("credential-store-indicator");
    expect(indicator).not.toBeNull();
    expect(indicator!.textContent).toContain("Unlocked");
  });

  it("clicking locked indicator opens unlock dialog", () => {
    const status: CredentialStoreStatusInfo = {
      mode: "master_password",
      status: "locked",
      keychainAvailable: false,
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
      keychainAvailable: false,
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
});

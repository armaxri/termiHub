import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { SecuritySettings } from "./SecuritySettings";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const mockedInvoke = vi.mocked(invoke);

let container: HTMLDivElement;
let root: Root;

function render(props: { visibleFields?: Set<string> } = {}) {
  act(() => {
    root.render(<SecuritySettings {...props} />);
  });
}

function query(testId: string): Element | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

describe("SecuritySettings", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());

    // Default: checkKeychainAvailable returns true
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "check_keychain_available") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("renders all three storage mode radio options", () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "none", status: "unlocked", keychainAvailable: true },
    });

    render();

    expect(query("storage-mode-keychain")).not.toBeNull();
    expect(query("storage-mode-master-password")).not.toBeNull();
    expect(query("storage-mode-none")).not.toBeNull();
  });

  it("shows auto-lock dropdown only when mode is master_password", () => {
    useAppStore.setState({
      credentialStoreStatus: {
        mode: "master_password",
        status: "unlocked",
        keychainAvailable: true,
      },
    });

    render();

    expect(query("auto-lock-timeout")).not.toBeNull();
  });

  it("hides auto-lock dropdown when mode is not master_password", () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "keychain", status: "unlocked", keychainAvailable: true },
    });

    render();

    expect(query("auto-lock-timeout")).toBeNull();
  });

  it("shows keychain available text when keychain is available", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "check_keychain_available") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });

    useAppStore.setState({
      credentialStoreStatus: { mode: "none", status: "unlocked", keychainAvailable: true },
    });

    await act(async () => {
      root.render(<SecuritySettings />);
    });

    const status = query("keychain-status");
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain("available");
  });

  it("shows warning text when keychain is not available", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "check_keychain_available") return Promise.resolve(false);
      return Promise.resolve(undefined);
    });

    useAppStore.setState({
      credentialStoreStatus: { mode: "none", status: "unlocked", keychainAvailable: false },
    });

    await act(async () => {
      root.render(<SecuritySettings />);
    });

    const status = query("keychain-status");
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain("not available");
  });

  it("shows change master password button only in master_password mode", () => {
    useAppStore.setState({
      credentialStoreStatus: {
        mode: "master_password",
        status: "unlocked",
        keychainAvailable: true,
      },
    });

    render();

    expect(query("change-master-password-btn")).not.toBeNull();
  });

  it("hides change master password button in non-master_password mode", () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "keychain", status: "unlocked", keychainAvailable: true },
    });

    render();

    expect(query("change-master-password-btn")).toBeNull();
  });
});

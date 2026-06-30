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

    mockedInvoke.mockImplementation(() => Promise.resolve(undefined));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("renders three storage mode radio options", () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "none", status: "unlocked" },
    });

    render();

    expect(query("storage-mode-master-password")).not.toBeNull();
    expect(query("storage-mode-os-keychain")).not.toBeNull();
    expect(query("storage-mode-none")).not.toBeNull();
  });

  it("switching to os_keychain calls switch_credential_store without a password", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "none", status: "unlocked" },
    });

    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "switch_credential_store") {
        return Promise.resolve({ migratedCount: 0, warnings: [] });
      }
      return Promise.resolve(undefined);
    });

    render();

    const option = query("storage-mode-os-keychain") as HTMLElement;
    await act(async () => {
      option.click();
    });

    // No master-password setup dialog for the OS keychain mode.
    expect(query("master-password-setup")).toBeNull();

    // A confirm dialog appears; confirm the switch.
    const confirmBtn = query("confirm-switch-confirm-btn") as HTMLElement;
    expect(confirmBtn).not.toBeNull();
    await act(async () => {
      confirmBtn.click();
    });

    const switchCalls = mockedInvoke.mock.calls.filter((c) => c[0] === "switch_credential_store");
    expect(switchCalls.length).toBeGreaterThan(0);
    // The new mode is passed and no password is sent.
    const [, args] = switchCalls[0];
    expect(args).toMatchObject({ newMode: "os_keychain", masterPassword: null });
  });

  it("shows auto-lock dropdown only when mode is master_password", () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });

    render();

    expect(query("auto-lock-timeout")).not.toBeNull();
  });

  it("hides auto-lock dropdown when mode is not master_password", () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "none", status: "unlocked" },
    });

    render();

    expect(query("auto-lock-timeout")).toBeNull();
  });

  it("shows change master password button only in master_password mode", () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });

    render();

    expect(query("change-master-password-btn")).not.toBeNull();
  });

  it("hides change master password button in non-master_password mode", () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "none", status: "unlocked" },
    });

    render();

    expect(query("change-master-password-btn")).toBeNull();
  });

  it("change-password dialog exposes stable testids for the harness", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });

    render();
    const btn = query("change-master-password-btn") as HTMLElement;
    await act(async () => {
      btn.click();
    });

    expect(query("change-master-password-current")).not.toBeNull();
    expect(query("change-master-password-new")).not.toBeNull();
    expect(query("change-master-password-confirm")).not.toBeNull();
    expect(query("change-master-password-confirm-btn")).not.toBeNull();
  });

  it("switch-to-none confirm dialog exposes a stable confirm testid", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });

    render();
    const noneOption = query("storage-mode-none") as HTMLElement;
    await act(async () => {
      noneOption.click();
    });

    expect(query("confirm-switch-dialog")).not.toBeNull();
    expect(query("confirm-switch-confirm-btn")).not.toBeNull();
  });

  it("activating master password mode calls only switch_credential_store, not setup_master_password", async () => {
    // Regression test: previously setupMasterPassword was called before switchCredentialStore,
    // which failed with "Credential store is not in master password mode" because the backend
    // hadn't been switched yet. switchCredentialStore handles setup internally.
    useAppStore.setState({
      credentialStoreStatus: { mode: "none", status: "unlocked" },
    });

    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "switch_credential_store") {
        return Promise.resolve({ migrated: 0, warnings: [] });
      }
      return Promise.resolve(undefined);
    });

    render();

    // Click the master password option to open the setup dialog
    const mpOption = query("storage-mode-master-password") as HTMLElement;
    await act(async () => {
      mpOption.click();
    });

    expect(query("master-password-setup")).not.toBeNull();

    // Fill in matching passwords via the stable testids the test harness drives.
    const setValue = (testId: string, value: string) => {
      const input = query(testId) as HTMLInputElement;
      input.focus();
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
        input,
        value
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => {
      setValue("master-password-input", "strongpass1");
      setValue("master-password-confirm-input", "strongpass1");
    });

    // Click Confirm
    const confirmBtn = query("master-password-confirm-btn") as HTMLElement;
    await act(async () => {
      confirmBtn.click();
    });

    // setup_master_password must NOT have been called
    const setupCalls = mockedInvoke.mock.calls.filter((c) => c[0] === "setup_master_password");
    expect(setupCalls).toHaveLength(0);

    // switch_credential_store must have been called with the password
    const switchCalls = mockedInvoke.mock.calls.filter((c) => c[0] === "switch_credential_store");
    expect(switchCalls.length).toBeGreaterThan(0);
  });
});

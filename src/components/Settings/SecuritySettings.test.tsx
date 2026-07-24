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

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: { success: vi.fn(), error: vi.fn() },
  };
});

import { toast } from "@/components/ui";

const mockedInvoke = vi.mocked(invoke);
const mockedToast = vi.mocked(toast);

/** Sets a controlled input's value the way the harness does (React-friendly). */
function setInputValue(input: HTMLInputElement, value: string) {
  input.focus();
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
    input,
    value
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

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

  it("shows a success toast after a successful store switch", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });

    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "switch_credential_store") {
        return Promise.resolve({ migratedCount: 2, warnings: [] });
      }
      return Promise.resolve(undefined);
    });

    render();

    const noneOption = query("storage-mode-none") as HTMLElement;
    await act(async () => {
      noneOption.click();
    });

    const confirmBtn = query("confirm-switch-confirm-btn") as HTMLElement;
    await act(async () => {
      confirmBtn.click();
    });

    expect(mockedToast.success).toHaveBeenCalled();
  });

  it("shows an error toast when the store switch fails", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });

    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "switch_credential_store") {
        return Promise.reject(new Error("switch boom"));
      }
      return Promise.resolve(undefined);
    });

    render();

    const noneOption = query("storage-mode-none") as HTMLElement;
    await act(async () => {
      noneOption.click();
    });

    const confirmBtn = query("confirm-switch-confirm-btn") as HTMLElement;
    await act(async () => {
      confirmBtn.click();
    });

    expect(mockedToast.error).toHaveBeenCalled();
    expect(mockedToast.success).not.toHaveBeenCalled();
  });

  it("shows a success toast after changing the master password", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });

    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "change_master_password") {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    render();

    const btn = query("change-master-password-btn") as HTMLElement;
    await act(async () => {
      btn.click();
    });

    await act(async () => {
      setInputValue(query("change-master-password-current") as HTMLInputElement, "oldpass12");
      setInputValue(query("change-master-password-new") as HTMLInputElement, "newpass123");
      setInputValue(query("change-master-password-confirm") as HTMLInputElement, "newpass123");
    });

    const confirmBtn = query("change-master-password-confirm-btn") as HTMLElement;
    await act(async () => {
      confirmBtn.click();
    });

    expect(mockedToast.success).toHaveBeenCalled();
  });

  it("triggers the unlock flow when Change Master Password is clicked while locked", async () => {
    // GAP G4: change_master_password requires an unlocked store. When locked, the
    // change-password button must route through the unlock flow instead of opening a
    // dialog that dead-ends on a raw "Store is locked" error.
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "locked" },
    });

    // requestUnlock never resolves here so we can assert it was invoked and that the
    // change dialog does NOT open before the store is unlocked.
    const requestUnlock = vi.fn(() => new Promise<boolean>(() => {}));
    useAppStore.setState({ requestUnlock });

    render();

    const btn = query("change-master-password-btn") as HTMLElement;
    await act(async () => {
      btn.click();
    });

    expect(requestUnlock).toHaveBeenCalledTimes(1);
    // The change-password dialog stays closed until the store is unlocked.
    expect(query("change-password-dialog")).toBeNull();
  });

  it("opens the change-password dialog after a successful unlock while locked", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "locked" },
    });

    const requestUnlock = vi.fn(() => Promise.resolve(true));
    useAppStore.setState({ requestUnlock });

    render();

    const btn = query("change-master-password-btn") as HTMLElement;
    await act(async () => {
      btn.click();
    });

    expect(requestUnlock).toHaveBeenCalledTimes(1);
    // Unlock succeeded, so the change-password dialog is now available.
    expect(query("change-password-dialog")).not.toBeNull();
  });

  it("does not open the change-password dialog if the unlock is cancelled while locked", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "locked" },
    });

    const requestUnlock = vi.fn(() => Promise.resolve(false));
    useAppStore.setState({ requestUnlock });

    render();

    const btn = query("change-master-password-btn") as HTMLElement;
    await act(async () => {
      btn.click();
    });

    expect(requestUnlock).toHaveBeenCalledTimes(1);
    expect(query("change-password-dialog")).toBeNull();
  });

  // --- #1360: switching away from an existing master-password store is gated ---

  it("routes a switch away from master_password through requestUnlock while locked", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "locked" },
    });
    // Never resolves: lets us assert requestUnlock ran and the confirm did NOT open.
    const requestUnlock = vi.fn(() => new Promise<boolean>(() => {}));
    useAppStore.setState({ requestUnlock });

    render();

    const noneOption = query("storage-mode-none") as HTMLElement;
    await act(async () => {
      noneOption.click();
    });

    expect(requestUnlock).toHaveBeenCalledTimes(1);
    // The switch confirm stays closed until the store is unlocked.
    expect(query("confirm-switch-dialog")).toBeNull();
  });

  it("opens the switch confirm after a successful unlock when leaving master_password", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "locked" },
    });
    const requestUnlock = vi.fn(() => Promise.resolve(true));
    useAppStore.setState({ requestUnlock });

    render();

    const noneOption = query("storage-mode-none") as HTMLElement;
    await act(async () => {
      noneOption.click();
    });

    expect(requestUnlock).toHaveBeenCalledTimes(1);
    expect(query("confirm-switch-dialog")).not.toBeNull();
  });

  it("does not open the switch confirm if the unlock is cancelled", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "locked" },
    });
    const requestUnlock = vi.fn(() => Promise.resolve(false));
    useAppStore.setState({ requestUnlock });

    render();

    const noneOption = query("storage-mode-none") as HTMLElement;
    await act(async () => {
      noneOption.click();
    });

    expect(requestUnlock).toHaveBeenCalledTimes(1);
    expect(query("confirm-switch-dialog")).toBeNull();
  });

  it("does not gate a switch when the master-password store is already unlocked", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });
    const requestUnlock = vi.fn(() => Promise.resolve(true));
    useAppStore.setState({ requestUnlock });

    render();

    const noneOption = query("storage-mode-none") as HTMLElement;
    await act(async () => {
      noneOption.click();
    });

    expect(requestUnlock).not.toHaveBeenCalled();
    expect(query("confirm-switch-dialog")).not.toBeNull();
  });

  it("uses strengthened, irreversible copy in the switch-to-none confirm", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });

    render();

    const noneOption = query("storage-mode-none") as HTMLElement;
    await act(async () => {
      noneOption.click();
    });

    const dialog = query("confirm-switch-dialog") as HTMLElement;
    expect(dialog.textContent).toMatch(/permanently/i);
    expect(dialog.textContent).toMatch(/cannot be undone/i);
  });

  it("keeps the wrong-password change failure inline (no success toast, dialog stays open)", async () => {
    // Per the audit, the wrong-current-password case stays an inline field error
    // (not a toast); only the success path is promoted to a toast.
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });

    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "change_master_password") {
        return Promise.reject(new Error("Current password is incorrect"));
      }
      return Promise.resolve(undefined);
    });

    render();

    const btn = query("change-master-password-btn") as HTMLElement;
    await act(async () => {
      btn.click();
    });

    await act(async () => {
      setInputValue(query("change-master-password-current") as HTMLInputElement, "wrongpass1");
      setInputValue(query("change-master-password-new") as HTMLInputElement, "newpass123");
      setInputValue(query("change-master-password-confirm") as HTMLInputElement, "newpass123");
    });

    const confirmBtn = query("change-master-password-confirm-btn") as HTMLElement;
    await act(async () => {
      confirmBtn.click();
    });

    expect(mockedToast.success).not.toHaveBeenCalled();
    // The inline error still surfaces the wrong-password feedback; dialog stays open.
    expect(query("change-password-dialog")).not.toBeNull();
  });

  describe("workflow local process execution (#1857)", () => {
    it("shows the opt-in toggle, off by default, with no allowlist section", () => {
      useAppStore.setState({
        credentialStoreStatus: { mode: "none", status: "unlocked" },
      });
      render();

      expect(query("workflow-local-process-toggle")).not.toBeNull();
      // The allowlist section only appears once the opt-in is on.
      expect(query("workflow-allowlist")).toBeNull();
      expect(query("workflow-allowlist-empty")).toBeNull();
    });

    it("enabling the opt-in persists the setting", async () => {
      useAppStore.setState({
        credentialStoreStatus: { mode: "none", status: "unlocked" },
      });
      render();

      const toggle = query("workflow-local-process-toggle") as HTMLElement;
      await act(async () => {
        toggle.click();
      });

      expect(useAppStore.getState().settings.workflowLocalProcessEnabled).toBe(true);
    });

    it("lists allowed programs and removes one on click", async () => {
      useAppStore.setState({
        credentialStoreStatus: { mode: "none", status: "unlocked" },
        settings: {
          ...useAppStore.getState().settings,
          workflowLocalProcessEnabled: true,
          workflowLocalProcessAllowlist: ["notify-send", "echo"],
        },
      });
      render();

      const list = query("workflow-allowlist");
      expect(list).not.toBeNull();
      expect(list?.querySelectorAll("li")).toHaveLength(2);

      const remove = query("workflow-allowlist-remove-echo") as HTMLElement;
      await act(async () => {
        remove.click();
      });

      expect(useAppStore.getState().settings.workflowLocalProcessAllowlist).toEqual([
        "notify-send",
      ]);
    });
  });
});

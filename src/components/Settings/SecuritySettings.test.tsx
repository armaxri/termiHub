import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { currentSettingsView } from "@/store/settingsBridge";
import { SecuritySettings } from "./SecuritySettings";
import { checkA11y } from "@/test/axe";
import { pressRadioArrow } from "@/test/radioKeyboard";
import { expectedStorageCards, readStorageCards } from "@/test/credentialStorageCards";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
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

async function render(props: { visibleFields?: Set<string> } = {}) {
  await act(async () => {
    root.render(<SecuritySettings {...props} />);
  });
}

function query(testId: string): Element | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

setupSettingsRegion();

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

  it("renders three storage mode radio options", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "none", status: "unlocked" },
    });

    await render();

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
        return Promise.resolve({
          status: "success",
          migratedCount: 0,
          failedCount: 0,
          warnings: [],
          removedCount: 0,
          remaining: [],
          rolledBack: false,
        });
      }
      return Promise.resolve(undefined);
    });

    await render();

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

  it("shows auto-lock dropdown only when mode is master_password", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });

    await render();

    expect(query("auto-lock-timeout")).not.toBeNull();
  });

  it("hides auto-lock dropdown when mode is not master_password", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "none", status: "unlocked" },
    });

    await render();

    expect(query("auto-lock-timeout")).toBeNull();
  });

  it("shows change master password button only in master_password mode", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });

    await render();

    expect(query("change-master-password-btn")).not.toBeNull();
  });

  it("hides change master password button in non-master_password mode", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "none", status: "unlocked" },
    });

    await render();

    expect(query("change-master-password-btn")).toBeNull();
  });

  it("change-password dialog exposes stable testids for the harness", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });

    await render();
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

    await render();
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
        return Promise.resolve({
          status: "success",
          migratedCount: 0,
          failedCount: 0,
          warnings: [],
          removedCount: 0,
          remaining: [],
          rolledBack: false,
        });
      }
      return Promise.resolve(undefined);
    });

    await render();

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

  it("confirms a successful store switch once, inline, without a toast (#5629)", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });

    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "switch_credential_store") {
        return Promise.resolve({
          status: "success",
          migratedCount: 2,
          failedCount: 0,
          warnings: [],
          removedCount: 0,
          remaining: [],
          rolledBack: false,
        });
      }
      return Promise.resolve(undefined);
    });

    await render();

    const noneOption = query("storage-mode-none") as HTMLElement;
    await act(async () => {
      noneOption.click();
    });

    const confirmBtn = query("confirm-switch-confirm-btn") as HTMLElement;
    await act(async () => {
      confirmBtn.click();
    });

    expect(query("migration-result")).not.toBeNull();
    expect(container.textContent?.match(/Switched to/g)).toHaveLength(1);
    expect(mockedToast.success).not.toHaveBeenCalled();
    expect(mockedToast.info).not.toHaveBeenCalled();
  });

  it("shows a failed store switch inline in the confirm, without a toast (#5629)", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });

    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "switch_credential_store") {
        return Promise.reject(new Error("switch boom"));
      }
      return Promise.resolve(undefined);
    });

    await render();

    const noneOption = query("storage-mode-none") as HTMLElement;
    await act(async () => {
      noneOption.click();
    });

    const confirmBtn = query("confirm-switch-confirm-btn") as HTMLElement;
    await act(async () => {
      confirmBtn.click();
    });

    const dialog = query("confirm-switch-dialog") as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("switch boom");
    expect(mockedToast.error).not.toHaveBeenCalled();
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

    await render();

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

  it("triggers the unlock flow when Change master password is clicked while locked", async () => {
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

    await render();

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

    await render();

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

    await render();

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

    await render();

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

    await render();

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

    await render();

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

    await render();

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

    await render();

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

    await render();

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
    it("shows the opt-in toggle, off by default, with no allowlist section", async () => {
      useAppStore.setState({
        credentialStoreStatus: { mode: "none", status: "unlocked" },
      });
      await render();

      expect(query("workflow-local-process-toggle")).not.toBeNull();
      // The allowlist section only appears once the opt-in is on.
      expect(query("workflow-allowlist")).toBeNull();
      expect(query("workflow-allowlist-empty")).toBeNull();
    });

    it("enabling the opt-in persists the setting", async () => {
      useAppStore.setState({
        credentialStoreStatus: { mode: "none", status: "unlocked" },
      });
      await render();

      const toggle = query("workflow-local-process-toggle") as HTMLElement;
      await act(async () => {
        toggle.click();
      });

      expect(currentSettingsView().workflowLocalProcessEnabled).toBe(true);
    });

    it("lists allowed programs and removes one on click", async () => {
      useAppStore.setState({
        credentialStoreStatus: { mode: "none", status: "unlocked" },
      });
      seedSettings({
        workflowLocalProcessEnabled: true,
        workflowLocalProcessAllowlist: ["notify-send", "echo"],
      });
      await render();

      const list = query("workflow-allowlist");
      expect(list).not.toBeNull();
      expect(list?.querySelectorAll("li")).toHaveLength(2);

      const remove = query("workflow-allowlist-remove-echo") as HTMLElement;
      await act(async () => {
        remove.click();
      });

      expect(currentSettingsView().workflowLocalProcessAllowlist).toEqual(["notify-send"]);
    });
  });

  // #5629: each switch confirmation names its action and says what happens to
  // the saved credentials and the master-password vault.
  describe("switch confirmation copy (#5629)", () => {
    async function openSwitch(from: "master_password" | "os_keychain" | "none", to: string) {
      useAppStore.setState({ credentialStoreStatus: { mode: from, status: "unlocked" } });
      await render();
      await act(async () => {
        (query(to) as HTMLElement).click();
      });
    }

    it("names the move to the OS Keychain and says the vault is kept", async () => {
      await openSwitch("master_password", "storage-mode-os-keychain");
      const dialog = query("confirm-switch-dialog") as HTMLElement;
      const title = dialog.querySelector("h4")!.textContent;
      expect(title).toBe("Move saved credentials to OS Keychain?");
      expect(query("confirm-switch-confirm-btn")!.textContent).toBe("Move to OS Keychain");
      expect(dialog.textContent).toMatch(/master-password vault stays on this computer/);
      // One name for the target: never "OS credential store".
      expect(dialog.textContent).not.toMatch(/credential store/i);
      expect(dialog.textContent).not.toMatch(/\bConfirm\b/);
    });

    it("says nothing is moved when no storage was used before", async () => {
      await openSwitch("none", "storage-mode-os-keychain");
      const dialog = query("confirm-switch-dialog") as HTMLElement;
      expect(dialog.querySelector("h4")!.textContent).toBe("Use OS Keychain?");
      expect(query("confirm-switch-confirm-btn")!.textContent).toBe("Use OS Keychain");
      expect(dialog.textContent).toMatch(/nothing is moved/i);
    });

    it("names the delete when turning storage off, as a danger action", async () => {
      await openSwitch("os_keychain", "storage-mode-none");
      const dialog = query("confirm-switch-dialog") as HTMLElement;
      expect(dialog.querySelector("h4")!.textContent).toBe("Delete saved credentials?");
      const btn = query("confirm-switch-confirm-btn")!;
      expect(btn.textContent).toBe("Delete saved credentials");
      expect(btn.classList.contains("ui-btn--danger")).toBe(true);
      expect(dialog.textContent).toMatch(/saved in the OS Keychain/);
    });

    it("names the move into a master-password vault and keeps the keychain copies", async () => {
      await openSwitch("os_keychain", "storage-mode-master-password");
      const form = query("master-password-setup") as HTMLElement;
      expect(form.querySelector("h4")!.textContent).toBe(
        "Move saved credentials to a master-password vault"
      );
      expect(form.textContent).toMatch(/copies in the OS Keychain are left in place/);
      expect(query("master-password-confirm-btn")!.textContent).toBe("Move to Master password");
    });

    it("names turning the master password on from no storage", async () => {
      await openSwitch("none", "storage-mode-master-password");
      const form = query("master-password-setup") as HTMLElement;
      expect(form.querySelector("h4")!.textContent).toBe("Set master password");
      expect(query("master-password-confirm-btn")!.textContent).toBe("Turn on master password");
    });
  });

  // #2839: the switch flow must distinguish a clean migration from a partial or
  // failed one using the backend's structured `status`, never the warnings.
  describe("migration status", () => {
    async function switchFromMasterPasswordToKeychain(result: unknown) {
      useAppStore.setState({
        credentialStoreStatus: { mode: "master_password", status: "unlocked" },
      });
      mockedInvoke.mockImplementation((cmd) => {
        if (cmd === "switch_credential_store") return Promise.resolve(result);
        return Promise.resolve(undefined);
      });
      await render();
      await act(async () => {
        (query("storage-mode-os-keychain") as HTMLElement).click();
      });
      await act(async () => {
        (query("confirm-switch-confirm-btn") as HTMLElement).click();
      });
    }

    const base = { removedCount: 0, remaining: [], rolledBack: false };

    it("reports a clean success inline only, with no warnings", async () => {
      await switchFromMasterPasswordToKeychain({
        ...base,
        status: "success",
        migratedCount: 3,
        failedCount: 0,
        warnings: [],
      });

      const panel = query("migration-result") as HTMLElement;
      expect(panel.dataset.status).toBe("success");
      expect(panel.textContent).toContain("3 credentials migrated");
      expect(query("migration-warnings")).toBeNull();
      expect(mockedToast.success).not.toHaveBeenCalled();
      expect(mockedToast.info).not.toHaveBeenCalled();
      expect(mockedToast.error).not.toHaveBeenCalled();
    });

    it("reports a partial migration as informational and lists what failed", async () => {
      await switchFromMasterPasswordToKeychain({
        ...base,
        status: "partial",
        migratedCount: 2,
        failedCount: 1,
        warnings: ["Failed to migrate conn-1:password: denied"],
      });

      const panel = query("migration-result") as HTMLElement;
      expect(panel.dataset.status).toBe("partial");
      expect(panel.textContent).toContain("Switched to OS Keychain");
      expect(panel.textContent).toContain("2 of 3 credentials migrated");
      expect(panel.textContent).toContain("1 credential could not be moved");
      expect(panel.textContent).not.toContain("successfully");
      expect(query("migration-warnings")?.textContent).toContain("conn-1:password");
      expect(mockedToast.info).not.toHaveBeenCalled();
      expect(mockedToast.success).not.toHaveBeenCalled();
      expect(mockedToast.error).not.toHaveBeenCalled();
    });

    it("reports a rolled-back total failure as 'switch failed, nothing changed'", async () => {
      await switchFromMasterPasswordToKeychain({
        ...base,
        rolledBack: true,
        status: "failed",
        migratedCount: 0,
        failedCount: 2,
        warnings: ["Failed to migrate a:password: denied", "Failed to migrate b:password: denied"],
      });

      const panel = query("migration-result") as HTMLElement;
      expect(panel.dataset.status).toBe("failed");
      expect(panel.getAttribute("role")).toBe("alert");
      expect(panel.textContent).toContain("Switch failed, nothing changed");
      expect(panel.textContent).toContain("none of your 2 credentials could be moved");
      expect(panel.textContent).toContain("Master password is still active");
      expect(panel.textContent).not.toContain("Switched to");
      expect(query("migration-warnings")?.querySelectorAll("li")).toHaveLength(2);
      expect(mockedToast.error).not.toHaveBeenCalled();
      expect(mockedToast.success).not.toHaveBeenCalled();
    });

    async function switchFromMasterPasswordToNone(result: unknown) {
      useAppStore.setState({
        credentialStoreStatus: { mode: "master_password", status: "unlocked" },
      });
      mockedInvoke.mockImplementation((cmd) => {
        if (cmd === "switch_credential_store") return Promise.resolve(result);
        return Promise.resolve(undefined);
      });
      await render();
      await act(async () => {
        (query("storage-mode-none") as HTMLElement).click();
      });
      await act(async () => {
        (query("confirm-switch-confirm-btn") as HTMLElement).click();
      });
    }

    it("reports a switch to none as removed, never migrated", async () => {
      await switchFromMasterPasswordToNone({
        ...base,
        status: "success",
        migratedCount: 0,
        removedCount: 3,
        failedCount: 0,
        warnings: [],
      });

      const panel = query("migration-result") as HTMLElement;
      expect(panel.dataset.status).toBe("success");
      expect(panel.textContent).toContain("3 credentials removed");
      expect(panel.textContent).not.toContain("migrated");
      expect(query("migration-remaining")).toBeNull();
      expect(panel.textContent).toContain("Switched to None — 3 credentials removed.");
      expect(mockedToast.success).not.toHaveBeenCalled();
    });

    it("lists the entries a switch to none could not remove", async () => {
      await switchFromMasterPasswordToNone({
        ...base,
        status: "partial",
        migratedCount: 0,
        removedCount: 2,
        failedCount: 1,
        remaining: ["conn-9:password"],
        warnings: ["Failed to remove conn-9:password: disk full"],
      });

      const panel = query("migration-result") as HTMLElement;
      expect(panel.dataset.status).toBe("partial");
      expect(panel.textContent).toContain("2 of 3 credentials removed");
      expect(panel.textContent).toContain("1 credential could not be removed from Master password");
      expect(panel.textContent).toContain("Still stored in Master password:");
      const remaining = query("migration-remaining");
      expect(remaining?.querySelectorAll("li")).toHaveLength(1);
      expect(remaining?.textContent).toContain("conn-9:password");
      expect(mockedToast.info).not.toHaveBeenCalled();
    });

    it("reports a switch to none that removed nothing as rolled back", async () => {
      await switchFromMasterPasswordToNone({
        ...base,
        rolledBack: true,
        status: "failed",
        migratedCount: 0,
        removedCount: 0,
        failedCount: 1,
        remaining: ["conn-9:password"],
        warnings: ["Failed to remove conn-9:password: disk full"],
      });

      const panel = query("migration-result") as HTMLElement;
      expect(panel.textContent).toContain("Switch failed, nothing changed");
      expect(panel.textContent).toContain("none of your 1 credential could be removed");
      expect(query("migration-remaining")?.textContent).toContain("conn-9:password");
      expect(mockedToast.error).toHaveBeenCalledTimes(1);
    });
  });

  describe("storage-mode selector semantics (UISF2-002)", () => {
    it("shows the chooser's options: same order, names, descriptions, badge (#5553)", async () => {
      await render();
      const cards = readStorageCards(query("storage-mode-group")!);
      expect(cards).toEqual(expectedStorageCards());
      expect(cards[0]).toMatchObject({ label: "OS Keychain", badge: "Recommended" });
      expect(query("storage-mode-os-keychain-badge")?.textContent).toBe("Recommended");
    });

    beforeEach(() => {
      useAppStore.setState({
        credentialStoreStatus: { mode: "none", status: "unlocked" },
      });
    });

    it("marks each card with a radio mark and its own icon, like the chooser (#5560)", async () => {
      await render();
      const group = query("storage-mode-group")!;
      const cards = Array.from(group.querySelectorAll(".ui-radio-card"));
      expect(cards).toHaveLength(3);
      for (const card of cards) {
        expect(card.querySelector(".ui-radio-card__mark")?.getAttribute("aria-hidden")).toBe(
          "true"
        );
      }
      expect(readStorageCards(group).map((c) => c.icon)).toEqual([
        "os_keychain",
        "master_password",
        "none",
      ]);
    });

    it("calls out that the master password cannot be recovered (#5560)", async () => {
      await render();
      await act(async () => {
        (query("storage-mode-master-password") as HTMLElement).click();
      });
      const warning = query("master-password-warning")!;
      expect(warning.getAttribute("role")).toBe("note");
      expect(warning.textContent).toBe(
        "Your master password cannot be recovered if you forget it."
      );
      expect(query("master-password-setup")!.contains(warning)).toBe(true);
    });

    it("is a named radiogroup that owns radios (not aria-pressed toggles)", async () => {
      await render();
      const group = query("storage-mode-group") as HTMLElement;
      expect(group.getAttribute("role")).toBe("radiogroup");
      expect(group.getAttribute("aria-label")).toBe("Storage mode");
      for (const id of ["storage-mode-master-password", "storage-mode-os-keychain"]) {
        const el = query(id) as HTMLElement;
        expect(el.getAttribute("role")).toBe("radio");
        expect(el.hasAttribute("aria-pressed")).toBe(false);
        expect(el.getAttribute("aria-checked")).toBe("false");
      }
      expect(query("storage-mode-none")?.getAttribute("aria-checked")).toBe("true");
    });

    it("starts the switch flow for the option reached with an arrow key", async () => {
      await render();
      // Shared order (#5553): OS Keychain, Master password, None.
      const masterPassword = query("storage-mode-master-password") as HTMLElement;
      act(() => masterPassword.focus());
      await pressRadioArrow(masterPassword, "ArrowUp");
      expect(document.activeElement).toBe(query("storage-mode-os-keychain"));
      // The switch still needs confirmation; the confirm step is shown.
      expect(query("confirm-switch-confirm-btn")).not.toBeNull();
    });

    it("has no a11y violations", async () => {
      await render({ visibleFields: new Set(["credentialStorageMode"]) });
      expect(await checkA11y(container)).toHaveNoViolations();
    });
  });
});

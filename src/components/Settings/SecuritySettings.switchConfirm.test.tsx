/**
 * Credential-storage switch confirmation, progress and result (#5837).
 *
 * A switch that moves or deletes saved passwords asks first and says how many
 * and from where; one with nothing saved switches at once. Confirming shows
 * the new option and progress right away, the result uses the option cards'
 * words, and a clean result fades after a few seconds.
 */
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import type { CredentialStorageMode } from "@/types/credential";
import { SecuritySettings } from "./SecuritySettings";
import { SWITCH_RESULT_FADE_MS, SWITCH_RESULT_VISIBLE_MS } from "./credentialSwitchCopy";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return { ...actual, toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } };
});

import { toast } from "@/components/ui";

const mockedInvoke = vi.mocked(invoke);
const mockedToast = vi.mocked(toast);

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function checked(testId: string): boolean {
  return query(testId)?.getAttribute("aria-checked") === "true";
}

interface Backend {
  /** Answer of `count_saved_credentials`; an Error rejects it (a locked vault). */
  count: number | Error;
  migratedCount?: number;
  removedCount?: number;
  /** When set, the switch waits for this promise before answering. */
  hold?: Promise<void>;
}

/** Fakes the store: the count, the switch, and the mode the status reports after it. */
function fakeBackend(from: CredentialStorageMode, backend: Backend) {
  let mode = from;
  useAppStore.setState({ credentialStoreStatus: { mode, status: "unlocked" } });
  mockedInvoke.mockImplementation(async (cmd, args) => {
    if (cmd === "count_saved_credentials") {
      if (backend.count instanceof Error) throw backend.count;
      return backend.count;
    }
    if (cmd === "switch_credential_store") {
      if (backend.hold) await backend.hold;
      mode = (args as { newMode: CredentialStorageMode }).newMode;
      return {
        status: "success",
        migratedCount: backend.migratedCount ?? 0,
        removedCount: backend.removedCount ?? 0,
        failedCount: 0,
        warnings: [],
        remaining: [],
        rolledBack: false,
      };
    }
    if (cmd === "get_credential_store_status") return { mode, status: "unlocked" };
    return undefined;
  });
}

async function render() {
  await act(async () => {
    root.render(<SecuritySettings />);
  });
}

async function click(testId: string) {
  await act(async () => {
    query(testId)!.click();
  });
}

function switchCalls() {
  return mockedInvoke.mock.calls.filter((c) => c[0] === "switch_credential_store");
}

setupSettingsRegion();

describe("SecuritySettings — storage switch confirmation (#5837)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("asks before deleting saved passwords and says how many and from where", async () => {
    fakeBackend("master_password", { count: 2 });
    await render();
    await click("storage-mode-none");

    const dialog = query("confirm-switch-dialog")!;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector("h4")!.textContent).toBe("Stop saving passwords?");
    expect(dialog.textContent).toContain(
      "This permanently deletes the 2 saved passwords in your master-password vault"
    );
    expect(dialog.textContent).toContain("cannot be undone");
    expect(query("confirm-switch-confirm-btn")!.textContent).toBe("Delete saved passwords");
    expect(switchCalls()).toHaveLength(0);
  });

  it("asks before moving saved passwords to the OS Keychain and names the count", async () => {
    fakeBackend("master_password", { count: 1 });
    await render();
    await click("storage-mode-os-keychain");

    const dialog = query("confirm-switch-dialog")!;
    expect(dialog.querySelector("h4")!.textContent).toBe(
      "Move 1 saved password to the OS Keychain?"
    );
    expect(dialog.textContent).toContain("Your vault stays on this computer");
    expect(switchCalls()).toHaveLength(0);
  });

  it("names the count in the move into a master-password vault", async () => {
    fakeBackend("os_keychain", { count: 3 });
    await render();
    await click("storage-mode-master-password");

    expect(query("master-password-setup")!.querySelector("h4")!.textContent).toBe(
      "Move 3 saved passwords to a master-password vault"
    );
  });

  it("switches at once, without a confirmation, when the vault holds no passwords", async () => {
    fakeBackend("master_password", { count: 0 });
    await render();
    await click("storage-mode-none");

    expect(query("confirm-switch-dialog")).toBeNull();
    expect(switchCalls()).toHaveLength(1);
    expect(query("migration-result")!.textContent).toBe("Stopped saving passwords.");
  });

  it("still asks before deleting from the OS Keychain when its index lists nothing", async () => {
    // Items saved before termiHub's key index existed are not listed, so an
    // empty keychain count does not prove nothing is deleted.
    fakeBackend("os_keychain", { count: 0 });
    await render();
    await click("storage-mode-none");

    const dialog = query("confirm-switch-dialog")!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("every password termiHub saved in the OS Keychain");
    expect(switchCalls()).toHaveLength(0);
  });

  it("asks without a count when the count cannot be read", async () => {
    fakeBackend("master_password", { count: new Error("Store is locked") });
    await render();
    await click("storage-mode-os-keychain");

    expect(query("confirm-switch-dialog")!.querySelector("h4")!.textContent).toBe(
      "Move saved passwords to the OS Keychain?"
    );
  });

  it("keeps the storage unchanged when the confirmation is cancelled", async () => {
    fakeBackend("master_password", { count: 2 });
    await render();
    await click("storage-mode-none");
    await click("confirm-switch-cancel-btn");

    expect(query("confirm-switch-dialog")).toBeNull();
    expect(switchCalls()).toHaveLength(0);
    expect(checked("storage-mode-master-password")).toBe(true);
    expect(checked("storage-mode-none")).toBe(false);
    expect(useAppStore.getState().credentialStoreStatus?.mode).toBe("master_password");
  });

  it("selects the new option at once and shows progress while the switch runs", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    fakeBackend("master_password", { count: 2, migratedCount: 2, hold });
    await render();
    await click("storage-mode-os-keychain");
    await click("confirm-switch-confirm-btn");

    // Still running: the cards already show the target and the vault's
    // options are gone, so the screen never contradicts the choice.
    expect(checked("storage-mode-os-keychain")).toBe(true);
    expect(checked("storage-mode-master-password")).toBe(false);
    expect(query("auto-lock-timeout")).toBeNull();
    expect(query("confirm-switch-confirm-btn")!.textContent).toContain("Moving 2 passwords…");

    await act(async () => {
      release();
      await hold;
    });
    expect(checked("storage-mode-os-keychain")).toBe(true);
  });

  it("reports the move in plain words and keeps no toast on top", async () => {
    fakeBackend("master_password", { count: 1, migratedCount: 1 });
    await render();
    await click("storage-mode-os-keychain");
    await click("confirm-switch-confirm-btn");

    const result = query("migration-result")!;
    expect(result.textContent).toBe(
      "Moved 1 saved password to the OS Keychain. Your master-password vault is kept."
    );
    expect(result.textContent).not.toMatch(/migrated|Switched to|None/);
    expect(mockedToast.success).not.toHaveBeenCalled();
    expect(mockedToast.info).not.toHaveBeenCalled();
  });

  it("reports stopping in plain words with the number removed", async () => {
    fakeBackend("master_password", { count: 1, removedCount: 1 });
    await render();
    await click("storage-mode-none");
    await click("confirm-switch-confirm-btn");

    expect(query("migration-result")!.textContent).toBe(
      "Stopped saving passwords. 1 saved password removed."
    );
  });

  it("fades a clean result after a few seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fakeBackend("master_password", { count: 0 });
    await render();
    await click("storage-mode-none");
    const result = query("migration-result")!;
    expect(result.className).not.toContain("--fading");

    await act(async () => {
      vi.advanceTimersByTime(SWITCH_RESULT_VISIBLE_MS);
    });
    expect(query("migration-result")!.className).toContain(
      "settings-panel__migration-result--fading"
    );

    await act(async () => {
      vi.advanceTimersByTime(SWITCH_RESULT_FADE_MS);
    });
    expect(query("migration-result")).toBeNull();
  });
});

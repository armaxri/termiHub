import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import type { StorageChoiceOutcome } from "@/store/slices/credentialStoreSlice";
import type { CredentialStorageMode, CredentialStoreStatusInfo } from "@/types/credential";
import { CredentialStorageChooser } from "./CredentialStorageChooser";

const mockedInvoke = vi.mocked(invoke);

let container: HTMLDivElement;
let root: Root;
/** The store mode the fake backend reports; switched by `switch_credential_store`. */
let backendMode: CredentialStorageMode;
let switchSucceeds: boolean;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function setInputValue(input: HTMLInputElement, value: string) {
  input.focus();
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
    input,
    value
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const status = (mode: CredentialStorageMode, chosen: boolean): CredentialStoreStatusInfo => ({
  mode,
  status: mode === "none" ? "unavailable" : "unlocked",
  storageChosen: chosen,
});

function calls(cmd: string) {
  return mockedInvoke.mock.calls.filter((c) => c[0] === cmd);
}

/** Open the chooser the way a save flow does, and capture how it settles. */
async function openChooser(): Promise<{ outcome: () => StorageChoiceOutcome | undefined }> {
  let outcome: StorageChoiceOutcome | undefined;
  await act(async () => {
    void useAppStore
      .getState()
      .requestStorageChoice()
      .then((o) => {
        outcome = o;
      });
  });
  return { outcome: () => outcome };
}

async function click(testId: string) {
  await act(async () => {
    query(testId)!.click();
  });
}

describe("CredentialStorageChooser (#5187)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({ credentialStoreStatus: status("none", false) });
    backendMode = "none";
    switchSucceeds = true;
    mockedInvoke.mockImplementation((cmd, args) => {
      switch (cmd) {
        case "switch_credential_store": {
          const mode = (args as { newMode: CredentialStorageMode }).newMode;
          if (switchSucceeds) backendMode = mode;
          return Promise.resolve({
            status: switchSucceeds ? "success" : "failed",
            migratedCount: 0,
            failedCount: 0,
            warnings: switchSucceeds ? [] : ["The OS keychain is not available."],
            removedCount: 0,
            remaining: [],
            rolledBack: !switchSucceeds,
          });
        }
        case "get_credential_store_status":
          return Promise.resolve(status(backendMode, backendMode !== "none"));
        case "mark_credential_storage_chosen":
          return Promise.resolve(status(backendMode, true));
        default:
          return Promise.resolve(undefined);
      }
    });
    act(() => {
      root.render(<CredentialStorageChooser />);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("is closed until a save flow asks", () => {
    expect(query("credential-storage-chooser")).toBeNull();
  });

  it("pre-selects the OS keychain and points to the setting", async () => {
    await openChooser();

    expect(query("credential-storage-chooser")).not.toBeNull();
    expect(
      query("credential-storage-chooser-option-os_keychain")?.getAttribute("aria-checked")
    ).toBe("true");
    expect(
      query("credential-storage-chooser-option-master_password")?.getAttribute("aria-checked")
    ).toBe("false");
    expect(query("credential-storage-chooser-options")?.textContent).toContain(
      "unlocked with your login"
    );
    expect(query("credential-storage-chooser-options")?.textContent).toContain("Portable");
    expect(query("credential-storage-chooser-change-later")?.textContent).toContain(
      "Settings ▸ Security"
    );
  });

  it("switches to the OS keychain on Continue and settles with it", async () => {
    const { outcome } = await openChooser();

    await click("credential-storage-chooser-continue");

    expect(calls("switch_credential_store").map((c) => c[1])).toEqual([
      { newMode: "os_keychain", masterPassword: null },
    ]);
    expect(outcome()).toBe("os_keychain");
    expect(useAppStore.getState().credentialStoreStatus?.mode).toBe("os_keychain");
    expect(useAppStore.getState().storageChooserOpen).toBe(false);
  });

  it("routes the master password choice into the setup and creates the vault", async () => {
    const { outcome } = await openChooser();

    await click("credential-storage-chooser-option-master_password");
    await click("credential-storage-chooser-continue");

    // Nothing is switched before the master password is set up.
    expect(calls("switch_credential_store")).toHaveLength(0);
    expect(query("credential-storage-chooser-master-password-setup")).not.toBeNull();

    await act(async () => {
      setInputValue(
        query("credential-storage-chooser-master-password-input") as HTMLInputElement,
        "correct horse"
      );
      setInputValue(
        query("credential-storage-chooser-master-password-confirm-input") as HTMLInputElement,
        "correct horse"
      );
    });
    await click("credential-storage-chooser-continue");

    expect(calls("switch_credential_store").map((c) => c[1])).toEqual([
      { newMode: "master_password", masterPassword: "correct horse" },
    ]);
    expect(outcome()).toBe("master_password");
  });

  it("rejects a mismatched master password without switching", async () => {
    const { outcome } = await openChooser();
    await click("credential-storage-chooser-option-master_password");
    await click("credential-storage-chooser-continue");

    await act(async () => {
      setInputValue(
        query("credential-storage-chooser-master-password-input") as HTMLInputElement,
        "correct horse"
      );
      setInputValue(
        query("credential-storage-chooser-master-password-confirm-input") as HTMLInputElement,
        "wrong horse"
      );
    });
    await click("credential-storage-chooser-continue");

    expect(query("credential-storage-chooser-master-password-error")?.textContent).toBe(
      "Passwords do not match."
    );
    expect(calls("switch_credential_store")).toHaveLength(0);
    expect(outcome()).toBeUndefined();
  });

  it("goes back from the master password setup to the choices", async () => {
    await openChooser();
    await click("credential-storage-chooser-option-master_password");
    await click("credential-storage-chooser-continue");

    await click("credential-storage-chooser-back");

    expect(query("credential-storage-chooser-options")).not.toBeNull();
  });

  it("records Don't save without switching any store", async () => {
    const { outcome } = await openChooser();

    await click("credential-storage-chooser-option-none");
    await click("credential-storage-chooser-continue");

    expect(calls("switch_credential_store")).toHaveLength(0);
    expect(calls("mark_credential_storage_chosen")).toHaveLength(1);
    expect(outcome()).toBe("none");
    expect(useAppStore.getState().credentialStoreStatus).toEqual(status("none", true));
  });

  it("cancel chooses nothing and saves nothing", async () => {
    const { outcome } = await openChooser();

    await click("credential-storage-chooser-cancel");

    expect(outcome()).toBe("canceled");
    expect(calls("switch_credential_store")).toHaveLength(0);
    expect(calls("mark_credential_storage_chosen")).toHaveLength(0);
    expect(useAppStore.getState().credentialStoreStatus).toEqual(status("none", false));
  });

  it("stays open with the error when the store cannot be set up", async () => {
    switchSucceeds = false;
    const { outcome } = await openChooser();

    await click("credential-storage-chooser-continue");

    expect(query("credential-storage-chooser-error")?.textContent).toContain(
      "The OS keychain is not available."
    );
    expect(outcome()).toBeUndefined();
    expect(useAppStore.getState().storageChooserOpen).toBe(true);
  });

  it("opens fresh on the OS keychain the next time", async () => {
    await openChooser();
    await click("credential-storage-chooser-option-none");
    await click("credential-storage-chooser-cancel");

    await openChooser();

    expect(
      query("credential-storage-chooser-option-os_keychain")?.getAttribute("aria-checked")
    ).toBe("true");
  });
});

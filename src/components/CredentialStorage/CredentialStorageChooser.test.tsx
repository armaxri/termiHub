import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import type { StorageChoiceOutcome } from "@/store/slices/credentialStoreSlice";
import type { CredentialStorageMode, CredentialStoreStatusInfo } from "@/types/credential";
import { CredentialStorageChooser } from "./CredentialStorageChooser";
import { expectedStorageCards, readStorageCards } from "@/test/credentialStorageCards";

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
    // The mismatch shows inline under the confirmation while typing (#5552)…
    expect(query("credential-storage-chooser-master-password-mismatch")?.textContent).toBe(
      "Passwords do not match."
    );
    await click("credential-storage-chooser-continue");

    // …and Create vault keeps it there instead of repeating it below.
    expect(query("credential-storage-chooser-master-password-mismatch")?.textContent).toBe(
      "Passwords do not match."
    );
    expect(query("credential-storage-chooser-master-password-error")).toBeNull();
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

  it("orders the master password setup footer Cancel, Back, Create vault (#5391)", async () => {
    const { outcome } = await openChooser();
    await click("credential-storage-chooser-option-master_password");
    await click("credential-storage-chooser-continue");

    const footerIds = [
      "credential-storage-chooser-cancel",
      "credential-storage-chooser-back",
      "credential-storage-chooser-continue",
    ].map((id) => query(id));
    expect(footerIds.every((el) => el !== null)).toBe(true);
    const [cancelBtn, backBtn, createBtn] = footerIds as HTMLElement[];
    expect(cancelBtn.compareDocumentPosition(backBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(backBtn.compareDocumentPosition(createBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(createBtn.textContent).toBe("Create vault");

    await click("credential-storage-chooser-cancel");
    expect(outcome()).toBe("canceled");
    expect(calls("switch_credential_store")).toHaveLength(0);
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

  async function pressEnter(el: Element) {
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
  }

  it("renders the shared option list Settings ▸ Security shows too (#5553)", async () => {
    await openChooser();
    expect(readStorageCards(query("credential-storage-chooser-options")!)).toEqual(
      expectedStorageCards()
    );
  });

  describe("keyboard (#5550)", () => {
    it("opens with focus on the selected option, not the close button", async () => {
      await openChooser();
      expect(document.activeElement).toBe(query("credential-storage-chooser-option-os_keychain"));
      expect(document.activeElement).not.toBe(query("modal-close"));
    });

    it("Enter on the selected option accepts it", async () => {
      const { outcome } = await openChooser();

      await pressEnter(document.activeElement!);

      expect(calls("switch_credential_store").map((c) => c[1])).toEqual([
        { newMode: "os_keychain", masterPassword: null },
      ]);
      expect(outcome()).toBe("os_keychain");
    });

    it("Enter on Master password moves on to the vault step", async () => {
      await openChooser();
      await click("credential-storage-chooser-option-master_password");

      await pressEnter(query("credential-storage-chooser-option-master_password")!);

      expect(query("credential-storage-chooser-master-password-setup")).not.toBeNull();
      expect(calls("switch_credential_store")).toHaveLength(0);
    });

    it("Enter in the confirmation field creates the vault", async () => {
      const { outcome } = await openChooser();
      await click("credential-storage-chooser-option-master_password");
      await click("credential-storage-chooser-continue");
      const confirm = query(
        "credential-storage-chooser-master-password-confirm-input"
      ) as HTMLInputElement;
      await act(async () => {
        setInputValue(
          query("credential-storage-chooser-master-password-input") as HTMLInputElement,
          "correct horse"
        );
        setInputValue(confirm, "correct horse");
      });

      await pressEnter(confirm);

      expect(outcome()).toBe("master_password");
    });
  });

  describe("primary action style (#5551)", () => {
    const primary = () => query("credential-storage-chooser-continue")!;

    it("keeps one filled primary look across Continue, Create vault and Back", async () => {
      await openChooser();
      expect(primary().className).toContain("ui-btn--primary");

      await click("credential-storage-chooser-option-master_password");
      await click("credential-storage-chooser-continue");
      expect(primary().textContent).toBe("Create vault");
      expect(primary().className).toContain("ui-btn--primary");
      expect(primary().className).not.toContain("ui-btn--success");

      await click("credential-storage-chooser-back");
      expect(primary().textContent).toBe("Continue");
      expect(primary().className).toContain("ui-btn--primary");
      expect(primary().className).not.toContain("ui-btn--success");
    });
  });

  describe("master password fields (#5552)", () => {
    async function openVaultStep() {
      await openChooser();
      await click("credential-storage-chooser-option-master_password");
      await click("credential-storage-chooser-continue");
    }
    const input = (suffix: string) =>
      query(`credential-storage-chooser-master-password-${suffix}`) as HTMLInputElement;

    it("labels both fields persistently instead of with placeholders", async () => {
      await openVaultStep();
      for (const [suffix, label] of [
        ["input", "Master password"],
        ["confirm-input", "Confirm password"],
      ]) {
        const el = input(suffix);
        expect(el.getAttribute("placeholder")).toBeNull();
        expect(document.querySelector(`label[for="${el.id}"]`)?.textContent).toBe(label);
      }
    });

    it("shows a live requirements hint linked to the password field", async () => {
      await openVaultStep();
      const hint = query("credential-storage-chooser-master-password-hint")!;
      expect(hint.textContent).toContain("at least 8 characters");
      expect(input("input").getAttribute("aria-describedby")).toContain(hint.id);

      await act(async () => setInputValue(input("input"), "abc"));
      expect(hint.textContent).toBe("5 more characters needed (at least 8).");

      await act(async () => setInputValue(input("input"), "correct horse"));
      expect(hint.textContent).toContain("Meets the 8-character minimum");
    });

    it("flags a mismatched confirmation inline, not while it is still a prefix", async () => {
      await openVaultStep();
      await act(async () => {
        setInputValue(input("input"), "correct horse");
        setInputValue(input("confirm-input"), "correct");
      });
      expect(query("credential-storage-chooser-master-password-mismatch")).toBeNull();

      await act(async () => setInputValue(input("confirm-input"), "correct cow"));
      expect(query("credential-storage-chooser-master-password-mismatch")?.textContent).toBe(
        "Passwords do not match."
      );
      expect(input("confirm-input").getAttribute("aria-invalid")).toBe("true");
    });
  });
});

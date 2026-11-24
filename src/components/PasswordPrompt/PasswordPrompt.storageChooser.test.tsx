import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import type { PasswordPromptAnswer } from "@/store/slices/passwordPromptSlice";
import type { CredentialStorageMode, CredentialStoreStatusInfo } from "@/types/credential";
import { CredentialStorageChooser } from "@/components/CredentialStorage";
import { saveAfterStorageChoice } from "@/utils/credentialStorageChoice";
import { PasswordPrompt } from "./PasswordPrompt";

const mockedInvoke = vi.mocked(invoke);

let container: HTMLDivElement;
let root: Root;
let backendMode: CredentialStorageMode;

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

async function click(testId: string) {
  await act(async () => {
    query(testId)!.click();
  });
}

/** Open a password prompt and capture its answer. */
async function prompt(): Promise<() => PasswordPromptAnswer | null | undefined> {
  let answer: PasswordPromptAnswer | null | undefined;
  await act(async () => {
    void useAppStore
      .getState()
      .requestPassword("example.com", "alice")
      .then((a) => {
        answer = a;
      });
  });
  await act(async () => {
    setInputValue(query("password-prompt-input") as HTMLInputElement, "s3cret");
  });
  return () => answer;
}

describe("PasswordPrompt first-use storage chooser (#5187, #5867)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({ credentialStoreStatus: status("none", false) });
    backendMode = "none";
    mockedInvoke.mockImplementation((cmd, args) => {
      switch (cmd) {
        case "switch_credential_store":
          backendMode = (args as { newMode: CredentialStorageMode }).newMode;
          return Promise.resolve({
            status: "success",
            migratedCount: 0,
            failedCount: 0,
            warnings: [],
            removedCount: 0,
            remaining: [],
            rolledBack: false,
          });
        case "get_credential_store_status":
          return Promise.resolve(status(backendMode, backendMode !== "none"));
        case "mark_credential_storage_chosen":
          return Promise.resolve(status(backendMode, true));
        default:
          return Promise.resolve(undefined);
      }
    });
    act(() => {
      root.render(
        <>
          <PasswordPrompt />
          <CredentialStorageChooser />
        </>
      );
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("offers a live, unticked save box before any choice exists", async () => {
    await prompt();

    const checkbox = query("password-prompt-save-checkbox");
    expect(checkbox?.hasAttribute("disabled")).toBe(false);
    expect(checkbox?.getAttribute("aria-checked")).toBe("false");
    expect(query("password-prompt-save-choose-hint")).not.toBeNull();
    expect(query("password-prompt-enable-storage")).toBeNull();
    expect(query("credential-storage-chooser")).toBeNull();
  });

  it("ticks the box locally and never opens the chooser over the prompt (#5867)", async () => {
    const answer = await prompt();

    await click("password-prompt-save-checkbox");
    expect(query("password-prompt-save-checkbox")?.getAttribute("aria-checked")).toBe("true");
    expect(query("credential-storage-chooser")).toBeNull();
    expect(useAppStore.getState().storageChooserOpen).toBe(false);
    // The hint says when it is saved and that termiHub asks once where.
    expect(query("password-prompt-save-choose-hint")?.textContent).toBe(
      "Saved once the connection succeeds. termiHub then asks once where to keep passwords."
    );

    await click("password-prompt-connect");
    expect(answer()).toEqual({ password: "s3cret", shouldSave: true });
    // Nothing was switched or saved by the prompt itself.
    expect(mockedInvoke.mock.calls.some((c) => c[0] === "switch_credential_store")).toBe(false);
    expect(query("credential-storage-chooser")).toBeNull();
  });

  it("an unticked box connects without saving or asking", async () => {
    const answer = await prompt();
    await click("password-prompt-connect");
    expect(answer()).toEqual({ password: "s3cret", shouldSave: false });
    expect(useAppStore.getState().storageChooserOpen).toBe(false);
  });

  it("after the connect succeeds, the chooser asks where and the save lands there", async () => {
    const answer = await prompt();
    await click("password-prompt-save-checkbox");
    await click("password-prompt-connect");
    expect(answer()?.shouldSave).toBe(true);
    expect(query("password-prompt-input")).toBeNull();

    // The save path runs once the connect succeeded.
    const save = vi.fn(() => Promise.resolve());
    let saved: boolean | undefined;
    await act(async () => {
      void saveAfterStorageChoice(save).then((v) => {
        saved = v;
      });
    });
    expect(query("credential-storage-chooser")).not.toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(
      query("credential-storage-chooser-option-os_keychain")?.getAttribute("aria-checked")
    ).toBe("true");

    await click("credential-storage-chooser-continue");
    expect(saved).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().credentialStoreStatus?.mode).toBe("os_keychain");
  });

  it("dismissing the post-connect chooser saves nothing and asks again next time", async () => {
    const save = vi.fn(() => Promise.resolve());
    let saved: boolean | undefined;
    await act(async () => {
      void saveAfterStorageChoice(save).then((v) => {
        saved = v;
      });
    });
    expect(query("credential-storage-chooser-cancel")?.textContent).toBe(
      "Don't save this password"
    );
    await click("credential-storage-chooser-cancel");
    expect(saved).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(mockedInvoke.mock.calls.some((c) => c[0] === "switch_credential_store")).toBe(false);

    // Still no choice: the next prompt's box is live again.
    await prompt();
    expect(query("password-prompt-save-checkbox")?.hasAttribute("disabled")).toBe(false);
    expect(query("password-prompt-save-choose-hint")).not.toBeNull();
  });

  it("choosing not to save is remembered: the next prompt shows the storage-off line", async () => {
    const save = vi.fn(() => Promise.resolve());
    await act(async () => {
      void saveAfterStorageChoice(save);
    });
    await click("credential-storage-chooser-option-none");
    await click("credential-storage-chooser-continue");
    expect(save).not.toHaveBeenCalled();

    await prompt();
    expect(query("password-prompt-save-checkbox")).toBeNull();
    expect(query("password-prompt-storage-off")?.textContent).toContain("Passwords aren't saved.");
  });

  it("once a store was chosen, the next prompt pre-ticks the box and saves without asking", async () => {
    await act(async () => {
      void saveAfterStorageChoice(() => Promise.resolve());
    });
    await click("credential-storage-chooser-continue");

    const second = await prompt();
    expect(query("password-prompt-save-checkbox")?.getAttribute("aria-checked")).toBe("true");
    await click("password-prompt-connect");
    expect(second()).toEqual({ password: "s3cret", shouldSave: true });
    const save = vi.fn(() => Promise.resolve());
    await act(async () => {
      expect(await saveAfterStorageChoice(save)).toBe(true);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(query("credential-storage-chooser")).toBeNull();
  });

  it("an install that already keeps credentials is never asked", async () => {
    useAppStore.setState({ credentialStoreStatus: status("master_password", true) });
    await prompt();

    expect(query("password-prompt-save-checkbox")?.getAttribute("aria-checked")).toBe("true");
    expect(query("password-prompt-save-choose-hint")).toBeNull();
    expect(useAppStore.getState().storageChooserOpen).toBe(false);
  });
});

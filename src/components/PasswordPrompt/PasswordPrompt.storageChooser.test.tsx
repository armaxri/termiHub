import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import type { PasswordPromptAnswer } from "@/store/slices/passwordPromptSlice";
import type { CredentialStorageMode, CredentialStoreStatusInfo } from "@/types/credential";
import { CredentialStorageChooser } from "@/components/CredentialStorage";
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

describe("PasswordPrompt first-use storage chooser (#5187)", () => {
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

  it("asks on the first save tick, defaulting to the keychain, then saves there", async () => {
    const answer = await prompt();

    await click("password-prompt-save-checkbox");
    expect(query("credential-storage-chooser")).not.toBeNull();
    expect(
      query("credential-storage-chooser-option-os_keychain")?.getAttribute("aria-checked")
    ).toBe("true");
    // Nothing has been switched or saved while the chooser is open.
    expect(mockedInvoke.mock.calls.some((c) => c[0] === "switch_credential_store")).toBe(false);

    await click("credential-storage-chooser-continue");

    expect(query("credential-storage-chooser")).toBeNull();
    expect(query("password-prompt-save-checkbox")?.getAttribute("aria-checked")).toBe("true");
    await click("password-prompt-connect");
    expect(answer()).toEqual({ password: "s3cret", shouldSave: true });
    expect(useAppStore.getState().credentialStoreStatus?.mode).toBe("os_keychain");
  });

  it("cancel keeps the box unticked, saves nothing, and asks again next time", async () => {
    const answer = await prompt();

    await click("password-prompt-save-checkbox");
    await click("credential-storage-chooser-cancel");

    expect(query("password-prompt-save-checkbox")?.getAttribute("aria-checked")).toBe("false");
    await click("password-prompt-connect");
    expect(answer()).toEqual({ password: "s3cret", shouldSave: false });
    expect(mockedInvoke.mock.calls.some((c) => c[0] === "switch_credential_store")).toBe(false);

    // The next prompt asks again.
    await prompt();
    await click("password-prompt-save-checkbox");
    expect(query("credential-storage-chooser")).not.toBeNull();
  });

  it("Don't save is remembered: the next prompt shows storage off and never asks", async () => {
    const answer = await prompt();

    await click("password-prompt-save-checkbox");
    await click("credential-storage-chooser-option-none");
    await click("credential-storage-chooser-continue");

    expect(query("password-prompt-save-checkbox")?.hasAttribute("disabled")).toBe(true);
    expect(query("password-prompt-storage-off")).not.toBeNull();
    await click("password-prompt-connect");
    expect(answer()).toEqual({ password: "s3cret", shouldSave: false });

    await prompt();
    expect(query("password-prompt-save-checkbox")?.hasAttribute("disabled")).toBe(true);
    expect(query("credential-storage-chooser")).toBeNull();
  });

  it("does not ask again on the second save once a store was chosen", async () => {
    const first = await prompt();
    await click("password-prompt-save-checkbox");
    await click("credential-storage-chooser-continue");
    await click("password-prompt-connect");
    expect(first()?.shouldSave).toBe(true);

    const second = await prompt();
    // An active store pre-ticks the box; no chooser.
    expect(query("password-prompt-save-checkbox")?.getAttribute("aria-checked")).toBe("true");
    await click("password-prompt-connect");
    expect(query("credential-storage-chooser")).toBeNull();
    expect(second()).toEqual({ password: "s3cret", shouldSave: true });
  });

  it("an install that already keeps credentials is never asked", async () => {
    useAppStore.setState({ credentialStoreStatus: status("master_password", true) });
    await prompt();

    expect(query("password-prompt-save-checkbox")?.getAttribute("aria-checked")).toBe("true");
    expect(query("password-prompt-save-choose-hint")).toBeNull();
    expect(useAppStore.getState().storageChooserOpen).toBe(false);
  });
});

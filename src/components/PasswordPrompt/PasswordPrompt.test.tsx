import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { PasswordPrompt } from "./PasswordPrompt";

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function render() {
  act(() => {
    root.render(<PasswordPrompt />);
  });
}

describe("PasswordPrompt", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("does not render when closed", () => {
    render();
    expect(query("password-prompt-input")).toBeNull();
  });

  it("renders input and buttons when open", async () => {
    await act(async () => {
      useAppStore.getState().requestPassword("example.com", "alice");
    });
    render();

    expect(query("password-prompt-input")).not.toBeNull();
    expect(query("password-prompt-connect")).not.toBeNull();
    expect(query("password-prompt-cancel")).not.toBeNull();
  });

  it("hides save checkbox when no credential store is configured", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "none", status: "unlocked", keychainAvailable: false },
    });
    await act(async () => {
      useAppStore.getState().requestPassword("example.com", "alice");
    });
    render();

    expect(query("password-prompt-save-checkbox")).toBeNull();
  });

  it("shows save checkbox pre-checked when credential store is active", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "keychain", status: "unlocked", keychainAvailable: true },
    });
    await act(async () => {
      useAppStore.getState().requestPassword("example.com", "alice");
    });
    render();

    const checkbox = query("password-prompt-save-checkbox") as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(true);
  });

  it("shows save checkbox pre-checked for master_password mode", async () => {
    useAppStore.setState({
      credentialStoreStatus: {
        mode: "master_password",
        status: "unlocked",
        keychainAvailable: false,
      },
    });
    await act(async () => {
      useAppStore.getState().requestPassword("example.com", "alice");
    });
    render();

    const checkbox = query("password-prompt-save-checkbox") as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(true);
  });

  it("sets passwordPromptShouldSave=true when submitting with checkbox checked", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "keychain", status: "unlocked", keychainAvailable: true },
    });
    useAppStore.getState().requestPassword("example.com", "alice");
    // Simulate submit with shouldSave=true (checkbox is checked by default when store is active)
    act(() => {
      useAppStore.getState().submitPassword("secret", true);
    });

    expect(useAppStore.getState().passwordPromptShouldSave).toBe(true);
  });

  it("sets passwordPromptShouldSave=false when submitting with checkbox unchecked", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "keychain", status: "unlocked", keychainAvailable: true },
    });
    useAppStore.getState().requestPassword("example.com", "alice");
    act(() => {
      useAppStore.getState().submitPassword("secret", false);
    });

    expect(useAppStore.getState().passwordPromptShouldSave).toBe(false);
  });

  it("resets passwordPromptShouldSave on dismiss", async () => {
    useAppStore.setState({ passwordPromptShouldSave: true });
    act(() => {
      useAppStore.getState().dismissPasswordPrompt();
    });

    expect(useAppStore.getState().passwordPromptShouldSave).toBe(false);
  });

  it("resolves the requestPassword promise with the entered password", async () => {
    const promise = useAppStore.getState().requestPassword("example.com", "alice");
    act(() => {
      useAppStore.getState().submitPassword("my-secret", false);
    });

    const result = await promise;
    expect(result).toBe("my-secret");
  });

  it("resolves requestPassword with null on dismiss", async () => {
    const promise = useAppStore.getState().requestPassword("example.com", "alice");
    act(() => {
      useAppStore.getState().dismissPasswordPrompt();
    });

    const result = await promise;
    expect(result).toBeNull();
  });
});

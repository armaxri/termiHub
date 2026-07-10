/**
 * Keyboard-interaction test for SecuritySettings (#1341): Enter submits the
 * credential dialogs from any field (not just the last), via a wrapping <form>.
 */
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
  return { ...actual, toast: { success: vi.fn(), error: vi.fn() } };
});

const mockedInvoke = vi.mocked(invoke);

let container: HTMLDivElement;
let root: Root;

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
    input,
    value
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function el<T extends HTMLElement>(testId: string): T {
  return container.querySelector<T>(`[data-testid="${testId}"]`)!;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("SecuritySettings — keyboard (#1341)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({ credentialStoreStatus: { mode: "none", status: "unlocked" } });
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "switch_credential_store") {
        return Promise.resolve({ migratedCount: 0, warnings: [] });
      }
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("submits the master-password setup on Enter from any field", async () => {
    act(() => root.render(<SecuritySettings />));

    // Open the master-password setup dialog.
    act(() => el<HTMLButtonElement>("storage-mode-master-password").click());

    act(() => setInputValue(el<HTMLInputElement>("master-password-input"), "supersecret1"));
    act(() => setInputValue(el<HTMLInputElement>("master-password-confirm-input"), "supersecret1"));

    // Submitting the form (what Enter from any field does) confirms the switch.
    const form = el<HTMLFormElement>("master-password-setup");
    expect(form.tagName).toBe("FORM");
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(mockedInvoke).toHaveBeenCalledWith(
      "switch_credential_store",
      expect.objectContaining({ newMode: "master_password", masterPassword: "supersecret1" })
    );
  });
});

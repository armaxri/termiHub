import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(),
}));

import { useAppStore } from "./appStore";

/**
 * The promise-based interactive host/SSH password prompt (PasswordPromptSlice,
 * extracted under #2077 via #2300): requestPassword opens the prompt and hands
 * back a promise that settles when the user submits (with the password) or
 * dismisses (with `null`) it, then clears the prompt state each time.
 */
describe("appStore password prompt", () => {
  beforeEach(() => {
    useAppStore.setState({
      passwordPromptOpen: false,
      passwordPromptHost: "",
      passwordPromptUsername: "",
      passwordPromptResolve: null,
      passwordPromptShouldSave: false,
    });
  });

  it("starts closed and empty", () => {
    const s = useAppStore.getState();
    expect(s.passwordPromptOpen).toBe(false);
    expect(s.passwordPromptHost).toBe("");
    expect(s.passwordPromptUsername).toBe("");
    expect(s.passwordPromptResolve).toBeNull();
    expect(s.passwordPromptShouldSave).toBe(false);
  });

  it("requestPassword opens the prompt with the host/username and a pending resolver", () => {
    useAppStore.getState().requestPassword("example.com", "alice");
    const s = useAppStore.getState();
    expect(s.passwordPromptOpen).toBe(true);
    expect(s.passwordPromptHost).toBe("example.com");
    expect(s.passwordPromptUsername).toBe("alice");
    expect(typeof s.passwordPromptResolve).toBe("function");
    expect(s.passwordPromptShouldSave).toBe(false);
  });

  it("submitPassword resolves the pending promise with the password and closes the prompt", async () => {
    const pending = useAppStore.getState().requestPassword("example.com", "alice");
    useAppStore.getState().submitPassword("hunter2", true);

    await expect(pending).resolves.toBe("hunter2");

    const s = useAppStore.getState();
    expect(s.passwordPromptOpen).toBe(false);
    expect(s.passwordPromptHost).toBe("");
    expect(s.passwordPromptUsername).toBe("");
    expect(s.passwordPromptResolve).toBeNull();
    expect(s.passwordPromptShouldSave).toBe(true);
  });

  it("submitPassword defaults shouldSave to false", async () => {
    const pending = useAppStore.getState().requestPassword("example.com", "alice");
    useAppStore.getState().submitPassword("hunter2");

    await expect(pending).resolves.toBe("hunter2");
    expect(useAppStore.getState().passwordPromptShouldSave).toBe(false);
  });

  it("dismissPasswordPrompt resolves the pending promise with null and closes the prompt", async () => {
    const pending = useAppStore.getState().requestPassword("example.com", "alice");
    useAppStore.getState().dismissPasswordPrompt();

    await expect(pending).resolves.toBeNull();

    const s = useAppStore.getState();
    expect(s.passwordPromptOpen).toBe(false);
    expect(s.passwordPromptHost).toBe("");
    expect(s.passwordPromptUsername).toBe("");
    expect(s.passwordPromptResolve).toBeNull();
    expect(s.passwordPromptShouldSave).toBe(false);
  });

  it("submit/dismiss with no pending prompt are safe no-ops", () => {
    expect(() => useAppStore.getState().submitPassword("x")).not.toThrow();
    expect(() => useAppStore.getState().dismissPasswordPrompt()).not.toThrow();
    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
  });
});

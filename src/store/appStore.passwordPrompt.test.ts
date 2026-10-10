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
 * back a promise that settles when the user submits (with the password and its
 * own Save choice, #4474) or
 * dismisses (with `null`) it, then clears the prompt state each time.
 */
describe("appStore password prompt", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("starts closed and empty", () => {
    const s = useAppStore.getState();
    expect(s.passwordPromptOpen).toBe(false);
    expect(s.passwordPromptHost).toBe("");
    expect(s.passwordPromptUsername).toBe("");
    expect(s.passwordPromptQueue).toHaveLength(0);
    expect("passwordPromptShouldSave" in s).toBe(false);
  });

  it("requestPassword opens the prompt with the host/username and a pending request", () => {
    useAppStore.getState().requestPassword("example.com", "alice");
    const s = useAppStore.getState();
    expect(s.passwordPromptOpen).toBe(true);
    expect(s.passwordPromptHost).toBe("example.com");
    expect(s.passwordPromptUsername).toBe("alice");
    expect(s.passwordPromptQueue).toHaveLength(1);
  });

  it("defaults the prompt kind to password and carries an explicit kind (UX-010)", () => {
    useAppStore.getState().requestPassword("example.com", "alice");
    expect(useAppStore.getState().passwordPromptKind).toBe("password");
    useAppStore.getState().dismissPasswordPrompt();

    useAppStore.getState().requestPassword("example.com", "alice", "", "key_passphrase");
    expect(useAppStore.getState().passwordPromptKind).toBe("key_passphrase");
  });

  it("resets the prompt kind to password on submit and dismiss (UX-010)", () => {
    useAppStore.getState().requestPassword("example.com", "alice", "", "key_passphrase");
    useAppStore.getState().submitPassword("secret");
    expect(useAppStore.getState().passwordPromptKind).toBe("password");

    useAppStore.getState().requestPassword("example.com", "alice", "", "key_passphrase");
    useAppStore.getState().dismissPasswordPrompt();
    expect(useAppStore.getState().passwordPromptKind).toBe("password");
  });

  it("submitPassword resolves the pending promise with the password and its Save choice", async () => {
    const pending = useAppStore.getState().requestPassword("example.com", "alice");
    useAppStore.getState().submitPassword("hunter2", true);

    await expect(pending).resolves.toEqual({ password: "hunter2", shouldSave: true });

    const s = useAppStore.getState();
    expect(s.passwordPromptOpen).toBe(false);
    expect(s.passwordPromptHost).toBe("");
    expect(s.passwordPromptUsername).toBe("");
    expect(s.passwordPromptQueue).toHaveLength(0);
  });

  it("submitPassword defaults shouldSave to false", async () => {
    const pending = useAppStore.getState().requestPassword("example.com", "alice");
    useAppStore.getState().submitPassword("hunter2");

    await expect(pending).resolves.toEqual({ password: "hunter2", shouldSave: false });
  });

  it("dismissPasswordPrompt resolves the pending promise with null and closes the prompt", async () => {
    const pending = useAppStore.getState().requestPassword("example.com", "alice");
    useAppStore.getState().dismissPasswordPrompt();

    await expect(pending).resolves.toBeNull();

    const s = useAppStore.getState();
    expect(s.passwordPromptOpen).toBe(false);
    expect(s.passwordPromptHost).toBe("");
    expect(s.passwordPromptUsername).toBe("");
    expect(s.passwordPromptQueue).toHaveLength(0);
  });

  it("submit/dismiss with no pending prompt are safe no-ops", () => {
    expect(() => useAppStore.getState().submitPassword("x")).not.toThrow();
    expect(() => useAppStore.getState().dismissPasswordPrompt()).not.toThrow();
    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
  });

  it("allows the Save control by default and carries an opt-out (#3316)", () => {
    useAppStore.getState().requestPassword("example.com", "alice");
    expect(useAppStore.getState().passwordPromptAllowSave).toBe(true);
    useAppStore.getState().dismissPasswordPrompt();

    useAppStore.getState().requestPassword("example.com", "alice", "", "password", {
      allowSave: false,
    });
    expect(useAppStore.getState().passwordPromptAllowSave).toBe(false);
  });

  it("never reports shouldSave from a prompt that disallowed saving (#3316)", async () => {
    const p = useAppStore
      .getState()
      .requestPassword("example.com", "alice", "", "password", { allowSave: false });
    useAppStore.getState().submitPassword("secret", true);
    await expect(p).resolves.toEqual({ password: "secret", shouldSave: false });
    // The opt-out does not leak into the next prompt.
    expect(useAppStore.getState().passwordPromptAllowSave).toBe(true);
  });
});

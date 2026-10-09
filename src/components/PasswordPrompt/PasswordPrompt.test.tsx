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

  it("labels the prompt as a password by default (UX-010)", async () => {
    await act(async () => {
      useAppStore.getState().requestPassword("example.com", "alice");
    });
    render();

    expect(document.querySelector(".ui-modal__title")?.textContent).toBe("SSH Password");
    expect(query("password-prompt-description")?.textContent).toContain(
      "Enter password for alice@example.com"
    );
    expect(query("password-prompt-input")?.getAttribute("placeholder")).toBe("Password");
    expect(query("password-prompt-input")?.getAttribute("aria-label")).toBe("SSH password");
  });

  it("labels the prompt as a key passphrase when kind is key_passphrase (UX-010)", async () => {
    await act(async () => {
      useAppStore.getState().requestPassword("example.com", "alice", "", "key_passphrase");
    });
    render();

    // The prompt must not call a key passphrase the account "SSH Password".
    expect(document.querySelector(".ui-modal__title")?.textContent).toBe("SSH Key Passphrase");
    expect(query("password-prompt-description")?.textContent).toContain("passphrase");
    expect(query("password-prompt-input")?.getAttribute("placeholder")).toBe("Passphrase");
    expect(query("password-prompt-input")?.getAttribute("aria-label")).toBe("SSH key passphrase");
  });

  it("labels the save checkbox for the passphrase case (UX-010)", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });
    await act(async () => {
      useAppStore.getState().requestPassword("example.com", "alice", "", "key_passphrase");
    });
    render();

    const checkbox = query("password-prompt-save-checkbox");
    expect(checkbox?.getAttribute("aria-label")).toBe("Save passphrase");
  });

  it("renders no notice for an ordinary prompt (UX-013)", async () => {
    await act(async () => {
      useAppStore.getState().requestPassword("example.com", "alice");
    });
    render();

    expect(query("password-prompt-notice")).toBeNull();
  });

  it("renders the re-prompt notice when requestPassword carries one (UX-013)", async () => {
    await act(async () => {
      useAppStore
        .getState()
        .requestPassword("example.com", "alice", "Saved password was rejected — please re-enter.");
    });
    render();

    const notice = query("password-prompt-notice");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("Saved password was rejected");
  });

  it("hides save checkbox when no credential store is configured", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "none", status: "unlocked" },
    });
    await act(async () => {
      useAppStore.getState().requestPassword("example.com", "alice");
    });
    render();

    expect(query("password-prompt-save-checkbox")).toBeNull();
  });

  it("shows save checkbox pre-checked when credential store is active", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });
    await act(async () => {
      useAppStore.getState().requestPassword("example.com", "alice");
    });
    render();

    const checkbox = query("password-prompt-save-checkbox");
    expect(checkbox).not.toBeNull();
    // Migrated to the shared Checkbox primitive (Radix): role=checkbox button
    // exposing aria-checked rather than a native input .checked.
    expect(checkbox?.getAttribute("aria-checked")).toBe("true");
  });

  it("shows save checkbox pre-checked for master_password mode", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });
    await act(async () => {
      useAppStore.getState().requestPassword("example.com", "alice");
    });
    render();

    const checkbox = query("password-prompt-save-checkbox");
    expect(checkbox).not.toBeNull();
    // Migrated to the shared Checkbox primitive (Radix): role=checkbox button
    // exposing aria-checked rather than a native input .checked.
    expect(checkbox?.getAttribute("aria-checked")).toBe("true");
  });

  it("sets passwordPromptShouldSave=true when submitting with checkbox checked", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
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
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });
    useAppStore.getState().requestPassword("example.com", "alice");
    act(() => {
      useAppStore.getState().submitPassword("secret", false);
    });

    expect(useAppStore.getState().passwordPromptShouldSave).toBe(false);
  });

  it("resets passwordPromptShouldSave on dismiss", async () => {
    void useAppStore.getState().requestPassword("example.com", "alice");
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

  it("hides the save checkbox when the caller disallows saving (#3316)", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });
    await act(async () => {
      useAppStore
        .getState()
        .requestPassword("example.com", "alice", "", "password", { allowSave: false });
    });
    render();

    expect(query("password-prompt-input")).not.toBeNull();
    expect(query("password-prompt-save-checkbox")).toBeNull();
    expect(query("password-prompt-save-label")).toBeNull();
  });

  it("submits without saving from a prompt that disallows saving (#3316)", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });
    let resolved: Promise<string | null> = Promise.resolve(null);
    await act(async () => {
      resolved = useAppStore
        .getState()
        .requestPassword("example.com", "alice", "", "password", { allowSave: false });
    });
    render();

    act(() => {
      query("password-prompt-connect")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await expect(resolved).resolves.toBe("");
    expect(useAppStore.getState().passwordPromptShouldSave).toBe(false);
  });

  describe("concurrent prompts (#4312)", () => {
    function typePassword(value: string) {
      const input = query("password-prompt-input") as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }

    function clickConnect() {
      act(() => {
        query("password-prompt-connect")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    }

    it("names the connection the prompt is for in its title", async () => {
      await act(async () => {
        void useAppStore
          .getState()
          .requestPassword("db.example", "alice", "", "password", { label: "Prod DB" });
      });
      render();

      expect(document.querySelector(".ui-modal__title")?.textContent).toBe(
        "SSH Password — Prod DB"
      );
    });

    it("says how many more prompts are waiting, and none for a single prompt", async () => {
      await act(async () => {
        void useAppStore.getState().requestPassword("a.example", "alice");
      });
      render();
      expect(query("password-prompt-queue")).toBeNull();

      await act(async () => {
        void useAppStore.getState().requestPassword("b.example", "bob");
        void useAppStore.getState().requestPassword("c.example", "carol");
      });
      expect(query("password-prompt-queue")?.textContent).toBe("2 more password prompts waiting");
    });

    it("answers the first prompt, then shows the next with a fresh input", async () => {
      let first: Promise<string | null> = Promise.resolve(null);
      let second: Promise<string | null> = Promise.resolve(null);
      await act(async () => {
        first = useAppStore.getState().requestPassword("a.example", "alice");
        second = useAppStore
          .getState()
          .requestPassword("b.example", "bob", "", "password", { label: "Jump host" });
      });
      render();

      typePassword("pw-a");
      clickConnect();
      await expect(first).resolves.toBe("pw-a");

      expect(query("password-prompt-description")?.textContent).toContain("bob@b.example");
      expect(document.querySelector(".ui-modal__title")?.textContent).toBe(
        "SSH Password — Jump host"
      );
      expect((query("password-prompt-input") as HTMLInputElement).value).toBe("");
      expect(query("password-prompt-queue")).toBeNull();

      typePassword("pw-b");
      clickConnect();
      await expect(second).resolves.toBe("pw-b");
      expect(query("password-prompt-input")).toBeNull();
    });

    it("cancel dismisses only the prompt on screen", async () => {
      let first: Promise<string | null> = Promise.resolve(null);
      await act(async () => {
        first = useAppStore.getState().requestPassword("a.example", "alice");
        void useAppStore.getState().requestPassword("b.example", "bob");
      });
      render();

      act(() => {
        query("password-prompt-cancel")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await expect(first).resolves.toBeNull();
      expect(query("password-prompt-description")?.textContent).toContain("bob@b.example");
    });
  });
});

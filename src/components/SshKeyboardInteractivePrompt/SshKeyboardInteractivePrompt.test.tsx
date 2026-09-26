/**
 * Tests for {@link SshKeyboardInteractivePrompt} — the global SSH
 * keyboard-interactive (OTP / 2FA) dialog (#3371). Verifies instruction/name
 * rendering, one field per prompt masked by the echo flag, submit/cancel
 * routing through `sshKeyboardInteractiveRespond`, queueing, and that a
 * backend "closed" notice drops the prompt.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type {
  SshKeyboardInteractivePromptClosedPayload,
  SshKeyboardInteractivePromptPayload,
} from "@/types/sshKeyboardInteractive";

let emitPrompt: ((p: SshKeyboardInteractivePromptPayload) => void) | undefined;
let emitClosed: ((p: SshKeyboardInteractivePromptClosedPayload) => void) | undefined;
const respondMock = vi.fn().mockResolvedValue(true);

vi.mock("@/services/events", () => ({
  onSshKeyboardInteractivePrompt: (cb: (p: SshKeyboardInteractivePromptPayload) => void) => {
    emitPrompt = cb;
    return Promise.resolve(() => {});
  },
  onSshKeyboardInteractivePromptClosed: (
    cb: (p: SshKeyboardInteractivePromptClosedPayload) => void
  ) => {
    emitClosed = cb;
    return Promise.resolve(() => {});
  },
}));

vi.mock("@/services/api", () => ({
  sshKeyboardInteractiveRespond: (promptId: string, responses: string[] | null) =>
    respondMock(promptId, responses),
}));

import { SshKeyboardInteractivePrompt } from "./SshKeyboardInteractivePrompt";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => root.render(ui));
}

async function fire(payload: SshKeyboardInteractivePromptPayload) {
  // Flush the mocked listener registration, then deliver the event.
  await act(async () => {
    await Promise.resolve();
  });
  act(() => emitPrompt?.(payload));
}

function q<T extends HTMLElement = HTMLElement>(testid: string): T | null {
  return document.querySelector(`[data-testid="${testid}"]`) as T | null;
}

function click(testid: string) {
  act(() => {
    q(testid)?.click();
  });
}

function type(testid: string, value: string) {
  const input = q<HTMLInputElement>(testid);
  if (!input) throw new Error(`missing input ${testid}`);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const otpPrompt: SshKeyboardInteractivePromptPayload = {
  prompt_id: "ki-1",
  host: "bastion.example",
  port: 22,
  username: "alice",
  name: "Duo two-factor",
  instructions: "Enter the code from your authenticator app.",
  prompts: [
    { prompt: "Password: ", echo: false },
    { prompt: "Device name: ", echo: true },
  ],
  round: 1,
};

const secondPrompt: SshKeyboardInteractivePromptPayload = {
  prompt_id: "ki-2",
  host: "db.internal",
  port: 2222,
  username: "bob",
  name: "",
  instructions: "",
  prompts: [{ prompt: "Verification code: ", echo: false }],
  round: 1,
};

describe("SshKeyboardInteractivePrompt", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    emitPrompt = undefined;
    emitClosed = undefined;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders nothing until a prompt arrives", () => {
    render(<SshKeyboardInteractivePrompt />);
    expect(q("kbd-interactive-submit")).toBeNull();
  });

  it("shows target, name, instructions and one field per prompt", async () => {
    render(<SshKeyboardInteractivePrompt />);
    await fire(otpPrompt);

    expect(q("kbd-interactive-target")?.textContent).toContain("alice@bastion.example:22");
    expect(q("kbd-interactive-name")?.textContent).toContain("Duo two-factor");
    expect(q("kbd-interactive-instructions")?.textContent).toBe(
      "Enter the code from your authenticator app."
    );
    // echo=false → masked; echo=true → plain text.
    expect(q<HTMLInputElement>("kbd-interactive-input-0")?.type).toBe("password");
    expect(q<HTMLInputElement>("kbd-interactive-input-1")?.type).toBe("text");
    // Trailing colon stripped for the accessible label.
    expect(q("kbd-interactive-input-0")?.getAttribute("aria-label")).toBe("Password");
  });

  it("submits the answers in prompt order", async () => {
    render(<SshKeyboardInteractivePrompt />);
    await fire(otpPrompt);

    type("kbd-interactive-input-0", "s3cret");
    type("kbd-interactive-input-1", "phone");
    click("kbd-interactive-submit");

    expect(respondMock).toHaveBeenCalledWith("ki-1", ["s3cret", "phone"]);
    expect(q("kbd-interactive-submit")).toBeNull();
  });

  it("submits on Enter", async () => {
    render(<SshKeyboardInteractivePrompt />);
    await fire(secondPrompt);

    type("kbd-interactive-input-0", "123456");
    act(() => {
      q("kbd-interactive-input-0")?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });

    expect(respondMock).toHaveBeenCalledWith("ki-2", ["123456"]);
  });

  it("cancel replies with null", async () => {
    render(<SshKeyboardInteractivePrompt />);
    await fire(otpPrompt);

    click("kbd-interactive-cancel");

    expect(respondMock).toHaveBeenCalledWith("ki-1", null);
    expect(q("kbd-interactive-submit")).toBeNull();
  });

  it("queues prompts and never carries answers over", async () => {
    render(<SshKeyboardInteractivePrompt />);
    await fire(secondPrompt);
    await fire(otpPrompt);

    type("kbd-interactive-input-0", "111111");
    click("kbd-interactive-submit");
    expect(respondMock).toHaveBeenLastCalledWith("ki-2", ["111111"]);

    // The next prompt is shown with empty fields.
    expect(q("kbd-interactive-target")?.textContent).toContain("alice@bastion.example:22");
    expect(q<HTMLInputElement>("kbd-interactive-input-0")?.value).toBe("");
  });

  it("drops a prompt the backend closed", async () => {
    render(<SshKeyboardInteractivePrompt />);
    await fire(otpPrompt);
    expect(q("kbd-interactive-submit")).not.toBeNull();

    act(() => emitClosed?.({ prompt_id: "ki-1" }));

    expect(q("kbd-interactive-submit")).toBeNull();
    expect(respondMock).not.toHaveBeenCalled();
  });
});

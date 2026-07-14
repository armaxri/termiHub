import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SudoPromptDialog } from "./SudoPromptDialog";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

/** Drive a controlled input the way React expects (native setter + input event). */
function typeInto(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const BASE_PROPS = {
  open: true,
  hostLabel: "pi@raspberrypi:22",
  targetPath: "/etc/hosts",
  attempt: 1,
  maxAttempts: 3,
  credentialStoreUnlocked: true,
  onSubmit: vi.fn(),
  onCancel: vi.fn(),
};

describe("SudoPromptDialog", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders nothing when closed", () => {
    render(<SudoPromptDialog {...BASE_PROPS} open={false} />);
    expect(query("sudo-prompt-dialog")).toBeNull();
  });

  it("names the host, user, and target file", () => {
    render(<SudoPromptDialog {...BASE_PROPS} />);
    expect(query("sudo-prompt-host")?.textContent).toContain("raspberrypi");
    expect(query("sudo-prompt-user")?.textContent).toContain("pi");
    expect(query("sudo-prompt-target")?.textContent).toContain("/etc/hosts");
  });

  it("masks the password field by default", () => {
    render(<SudoPromptDialog {...BASE_PROPS} />);
    const input = query("sudo-prompt-input") as HTMLInputElement;
    expect(input.getAttribute("type")).toBe("password");
  });

  it("disables Authorize until a non-empty password is entered", () => {
    render(<SudoPromptDialog {...BASE_PROPS} />);
    const submit = query("sudo-prompt-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    typeInto(query("sudo-prompt-input") as HTMLInputElement, "hunter2");
    expect(submit.disabled).toBe(false);
  });

  it("shows the 'Save in credential store' option only when the store is unlocked", () => {
    render(<SudoPromptDialog {...BASE_PROPS} credentialStoreUnlocked={true} />);
    expect(query("sudo-prompt-persist")).not.toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    render(<SudoPromptDialog {...BASE_PROPS} credentialStoreUnlocked={false} />);
    expect(query("sudo-prompt-persist")).toBeNull();
  });

  it("surfaces the attempt counter when re-prompting after a rejected password", () => {
    render(<SudoPromptDialog {...BASE_PROPS} attempt={2} />);
    const err = query("sudo-prompt-error");
    expect(err).not.toBeNull();
    expect(err?.textContent ?? "").toMatch(/attempt\s*2\s*of\s*3/i);
  });

  it("shows no attempt error on the first prompt", () => {
    render(<SudoPromptDialog {...BASE_PROPS} attempt={1} />);
    expect(query("sudo-prompt-error")).toBeNull();
  });

  it("submits the password with the caching choices (remember on by default)", () => {
    const onSubmit = vi.fn();
    render(<SudoPromptDialog {...BASE_PROPS} onSubmit={onSubmit} />);
    typeInto(query("sudo-prompt-input") as HTMLInputElement, "s3cret");
    act(() => {
      (query("sudo-prompt-submit") as HTMLButtonElement).click();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("s3cret", {
      rememberForSession: true,
      persistToStore: false,
    });
  });

  it("fires onCancel from the Cancel button", () => {
    const onCancel = vi.fn();
    render(<SudoPromptDialog {...BASE_PROPS} onCancel={onCancel} />);
    act(() => {
      (query("sudo-prompt-cancel") as HTMLButtonElement).click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

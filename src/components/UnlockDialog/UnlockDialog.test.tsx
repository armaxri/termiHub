import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { UnlockDialog } from "./UnlockDialog";

vi.mock("@/services/api", () => ({
  unlockCredentialStore: vi.fn(),
}));

import { unlockCredentialStore } from "@/services/api";

const mockedUnlock = vi.mocked(unlockCredentialStore);

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

describe("UnlockDialog", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders correctly when open", () => {
    act(() => {
      root.render(<UnlockDialog open={true} onOpenChange={vi.fn()} />);
    });

    expect(query("unlock-dialog-input")).not.toBeNull();
    expect(query("unlock-dialog-skip")).not.toBeNull();
    expect(query("unlock-dialog-unlock")).not.toBeNull();
  });

  it("does not render content when closed", () => {
    act(() => {
      root.render(<UnlockDialog open={false} onOpenChange={vi.fn()} />);
    });

    expect(query("unlock-dialog-input")).toBeNull();
  });

  it("calls unlockCredentialStore on submit and closes on success", async () => {
    mockedUnlock.mockResolvedValueOnce(undefined);
    const onOpenChange = vi.fn();

    act(() => {
      root.render(<UnlockDialog open={true} onOpenChange={onOpenChange} />);
    });

    const input = query("unlock-dialog-input") as HTMLInputElement;
    act(() => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!;
      nativeInputValueSetter.call(input, "my-password");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const unlockBtn = query("unlock-dialog-unlock") as HTMLButtonElement;
    await act(async () => {
      unlockBtn.click();
    });

    expect(mockedUnlock).toHaveBeenCalledWith("my-password");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows error on failed unlock and clears password", async () => {
    mockedUnlock.mockRejectedValueOnce(new Error("bad password"));
    const onOpenChange = vi.fn();

    act(() => {
      root.render(<UnlockDialog open={true} onOpenChange={onOpenChange} />);
    });

    const input = query("unlock-dialog-input") as HTMLInputElement;
    act(() => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!;
      nativeInputValueSetter.call(input, "wrong-password");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const unlockBtn = query("unlock-dialog-unlock") as HTMLButtonElement;
    await act(async () => {
      unlockBtn.click();
    });

    expect(query("unlock-dialog-error")).not.toBeNull();
    expect(query("unlock-dialog-error")!.textContent).toBe("Incorrect master password.");
    expect(onOpenChange).not.toHaveBeenCalled();

    // Password should be cleared
    const updatedInput = query("unlock-dialog-input") as HTMLInputElement;
    expect(updatedInput.value).toBe("");
  });

  it("skip calls onOpenChange(false)", () => {
    const onOpenChange = vi.fn();

    act(() => {
      root.render(<UnlockDialog open={true} onOpenChange={onOpenChange} />);
    });

    const skipBtn = query("unlock-dialog-skip") as HTMLButtonElement;
    act(() => {
      skipBtn.click();
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("unlock button is disabled when password is empty", () => {
    act(() => {
      root.render(<UnlockDialog open={true} onOpenChange={vi.fn()} />);
    });

    const unlockBtn = query("unlock-dialog-unlock") as HTMLButtonElement;
    expect(unlockBtn.disabled).toBe(true);
  });
});

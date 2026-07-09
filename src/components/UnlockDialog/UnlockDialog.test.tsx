import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { UnlockDialog } from "./UnlockDialog";

vi.mock("@/services/api", () => ({
  unlockCredentialStore: vi.fn(),
  resetCredentialStore: vi.fn(),
}));

import { unlockCredentialStore, resetCredentialStore } from "@/services/api";

const mockedUnlock = vi.mocked(unlockCredentialStore);
const mockedReset = vi.mocked(resetCredentialStore);

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

  // --- G8 (#1144): corrupt store surfaces a reset affordance, not a wrong-pw loop ---

  async function submitPassword(value: string) {
    const input = query("unlock-dialog-input") as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const unlockBtn = query("unlock-dialog-unlock") as HTMLButtonElement;
    await act(async () => {
      unlockBtn.click();
    });
  }

  it("shows the reset affordance (not wrong-password) when the store is corrupt", async () => {
    mockedUnlock.mockRejectedValueOnce({ message: "corrupt", corrupted: true });
    act(() => {
      root.render(<UnlockDialog open={true} onOpenChange={vi.fn()} />);
    });

    await submitPassword("anything");

    expect(query("unlock-dialog-reset")).not.toBeNull();
    // Must NOT tell the user their password is wrong in the corruption case.
    expect(query("unlock-dialog-error")?.textContent ?? "").not.toContain(
      "Incorrect master password"
    );
  });

  it("does NOT show the reset affordance on an ordinary wrong password", async () => {
    mockedUnlock.mockRejectedValueOnce({ message: "wrong", corrupted: false });
    act(() => {
      root.render(<UnlockDialog open={true} onOpenChange={vi.fn()} />);
    });

    await submitPassword("wrong-password");

    expect(query("unlock-dialog-reset")).toBeNull();
    expect(query("unlock-dialog-error")).not.toBeNull();
  });

  it("reset affordance calls resetCredentialStore and closes the dialog", async () => {
    mockedUnlock.mockRejectedValueOnce({ message: "corrupt", corrupted: true });
    mockedReset.mockResolvedValueOnce(undefined);
    const onOpenChange = vi.fn();
    act(() => {
      root.render(<UnlockDialog open={true} onOpenChange={onOpenChange} />);
    });

    await submitPassword("anything");

    const resetBtn = query("unlock-dialog-reset") as HTMLButtonElement;
    await act(async () => {
      resetBtn.click();
    });

    expect(mockedReset).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

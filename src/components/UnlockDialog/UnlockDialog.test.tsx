import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { UnlockDialog } from "./UnlockDialog";

vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return {
    isBiometricUnlockError: actual.isBiometricUnlockError,
    unlockCredentialStore: vi.fn(),
    resetCredentialStore: vi.fn(),
    getOsAuthInfo: vi.fn(),
    unlockCredentialStoreBiometric: vi.fn(),
  };
});

import {
  unlockCredentialStore,
  resetCredentialStore,
  getOsAuthInfo,
  unlockCredentialStoreBiometric,
} from "@/services/api";
import {
  OS_AUTH_AVAILABLE,
  OS_AUTH_BIOMETRIC_ENABLED,
  OS_AUTH_UNAVAILABLE,
} from "@/test/osAuthFixtures";

const mockedOsAuth = vi.mocked(getOsAuthInfo);
const mockedBiometric = vi.mocked(unlockCredentialStoreBiometric);

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
    mockedOsAuth.mockResolvedValue(OS_AUTH_UNAVAILABLE);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the description and the password field as separate blocks in one stack (#4710)", async () => {
    await act(async () => {
      root.render(<UnlockDialog open={true} onOpenChange={vi.fn()} />);
    });
    const body = query("unlock-dialog-body");
    expect(body).not.toBeNull();
    expect(body!.classList.contains("unlock-dialog__body")).toBe(true);
    const description = query("unlock-dialog-description");
    const field = query("unlock-dialog-field");
    // Both are direct children of the spacing container, so the stack gap
    // separates them and the input never sits on the description text.
    expect(description!.parentElement).toBe(body);
    expect(field!.parentElement).toBe(body);
    expect(description!.contains(query("unlock-dialog-input"))).toBe(false);
    expect(field!.contains(query("unlock-dialog-input"))).toBe(true);
    expect(field!.classList.contains("ui-field")).toBe(true);
    // The field carries a real label tied to the input.
    const input = query("unlock-dialog-input") as HTMLInputElement;
    expect(field!.querySelector(`label[for="${input.id}"]`)?.textContent).toBe("Master password");
    // The reset link is no longer in the body stack (#5188): it sits in the footer.
    expect(body!.contains(query("unlock-dialog-forgot"))).toBe(false);
  });

  it("keeps the error message as its own block in the stack (#4710)", async () => {
    mockedUnlock.mockRejectedValue(new Error("wrong"));
    await act(async () => {
      root.render(<UnlockDialog open={true} onOpenChange={vi.fn()} />);
    });
    const input = query("unlock-dialog-input") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "bad");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      query("unlock-dialog-unlock")!.click();
    });
    expect(query("unlock-dialog-error")!.parentElement).toBe(query("unlock-dialog-body"));
  });

  it("renders correctly when open", async () => {
    await act(async () => {
      root.render(<UnlockDialog open={true} onOpenChange={vi.fn()} />);
    });

    expect(query("unlock-dialog-input")).not.toBeNull();
    expect(query("unlock-dialog-cancel")).not.toBeNull();
    expect(query("unlock-dialog-unlock")).not.toBeNull();
    // No connect is waiting, so no fall-through is offered.
    expect(query("unlock-dialog-connect-without-saved")).toBeNull();
  });

  it("does not render content when closed", async () => {
    await act(async () => {
      root.render(<UnlockDialog open={false} onOpenChange={vi.fn()} />);
    });

    expect(query("unlock-dialog-input")).toBeNull();
  });

  it("calls unlockCredentialStore on submit and closes on success", async () => {
    mockedUnlock.mockResolvedValueOnce(undefined);
    const onOpenChange = vi.fn();

    await act(async () => {
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

    await act(async () => {
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

  it("cancel calls onOpenChange(false)", async () => {
    const onOpenChange = vi.fn();

    await act(async () => {
      root.render(<UnlockDialog open={true} onOpenChange={onOpenChange} />);
    });

    act(() => {
      (query("unlock-dialog-cancel") as HTMLButtonElement).click();
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // --- #5188: a waiting connect can go on without the vault ---

  it("offers 'Connect without saved password' instead of Skip when a connect waits", async () => {
    const onOpenChange = vi.fn();
    const onConnectWithoutSaved = vi.fn();
    await act(async () => {
      root.render(
        <UnlockDialog
          open={true}
          onOpenChange={onOpenChange}
          connectFallback={true}
          onConnectWithoutSaved={onConnectWithoutSaved}
        />
      );
    });

    const btn = query("unlock-dialog-connect-without-saved") as HTMLButtonElement;
    expect(btn.textContent).toBe("Connect without saved password");
    expect(document.body.textContent).not.toMatch(/\bSkip\b/);
    expect(query("unlock-dialog-cancel")).toBeNull();
    act(() => btn.click());

    expect(onConnectWithoutSaved).toHaveBeenCalledTimes(1);
    // Falling through is not a cancel: the dialog leaves the closing to the store.
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(mockedUnlock).not.toHaveBeenCalled();
  });

  it("Escape closes through onOpenChange(false) (the cancel path)", async () => {
    const onOpenChange = vi.fn();
    const onConnectWithoutSaved = vi.fn();
    await act(async () => {
      root.render(
        <UnlockDialog
          open={true}
          onOpenChange={onOpenChange}
          connectFallback={true}
          onConnectWithoutSaved={onConnectWithoutSaved}
        />
      );
    });

    act(() => {
      query("unlock-dialog-input")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      );
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConnectWithoutSaved).not.toHaveBeenCalled();
  });

  it("places the reset link under the actions, not under the error line", async () => {
    mockedUnlock.mockRejectedValueOnce(new Error("wrong"));
    await act(async () => {
      root.render(<UnlockDialog open={true} onOpenChange={vi.fn()} />);
    });
    const input = query("unlock-dialog-input") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "bad");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      query("unlock-dialog-unlock")!.click();
    });

    const error = query("unlock-dialog-error")!;
    const forgot = query("unlock-dialog-forgot")!;
    const unlock = query("unlock-dialog-unlock")!;
    const footer = query("unlock-dialog-footer")!;
    // The link is in the footer, not the body that holds the error line…
    expect(footer.contains(forgot)).toBe(true);
    expect(query("unlock-dialog-body")!.contains(forgot)).toBe(false);
    expect(error.nextElementSibling).toBeNull();
    // …and it comes after the action buttons in document order.
    expect(unlock.compareDocumentPosition(forgot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(error.compareDocumentPosition(forgot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // It stays tertiary.
    expect(forgot.closest(".unlock-dialog__forgot-row")).not.toBeNull();
  });

  it("unlock button is disabled when password is empty", async () => {
    await act(async () => {
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
    await act(async () => {
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
    await act(async () => {
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
    await act(async () => {
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

  // --- #1360: forgot-password recovery path (always available, guarded) ---

  it("always offers a forgot-password reset affordance, even without corruption", async () => {
    await act(async () => {
      root.render(<UnlockDialog open={true} onOpenChange={vi.fn()} />);
    });
    // No failed unlock, no corruption — the recovery affordance is still present.
    expect(query("unlock-dialog-forgot")).not.toBeNull();
  });

  it("does not reset immediately — it opens a destructive confirm first", async () => {
    await act(async () => {
      root.render(<UnlockDialog open={true} onOpenChange={vi.fn()} />);
    });

    const forgot = query("unlock-dialog-forgot") as HTMLButtonElement;
    await act(async () => {
      forgot.click();
    });

    // A confirm dialog appears warning that the reset is irreversible.
    expect(query("unlock-dialog-reset-confirm")).not.toBeNull();
    expect(document.body.textContent).toMatch(/permanently|cannot be undone/i);
    // The store is NOT reset until the user confirms.
    expect(mockedReset).not.toHaveBeenCalled();
  });

  it("resets the store only after the forgot-password confirm is accepted", async () => {
    mockedReset.mockResolvedValueOnce(undefined);
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(<UnlockDialog open={true} onOpenChange={onOpenChange} />);
    });

    const forgot = query("unlock-dialog-forgot") as HTMLButtonElement;
    await act(async () => {
      forgot.click();
    });

    const confirmBtn = query("confirm-dialog-confirm") as HTMLButtonElement;
    await act(async () => {
      confirmBtn.click();
    });

    expect(mockedReset).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not reset when the forgot-password confirm is cancelled", async () => {
    await act(async () => {
      root.render(<UnlockDialog open={true} onOpenChange={vi.fn()} />);
    });

    const forgot = query("unlock-dialog-forgot") as HTMLButtonElement;
    await act(async () => {
      forgot.click();
    });

    const cancelBtn = query("confirm-dialog-cancel") as HTMLButtonElement;
    await act(async () => {
      cancelBtn.click();
    });

    expect(mockedReset).not.toHaveBeenCalled();
    expect(query("unlock-dialog-reset-confirm")).toBeNull();
  });

  describe("biometric unlock (PROD-064)", () => {
    async function renderOpen(onOpenChange = vi.fn()) {
      await act(async () => {
        root.render(<UnlockDialog open={true} onOpenChange={onOpenChange} />);
      });
      await act(async () => {});
      return onOpenChange;
    }

    it("does not offer biometrics when not turned on", async () => {
      mockedOsAuth.mockResolvedValue(OS_AUTH_AVAILABLE);
      await renderOpen();
      expect(query("unlock-dialog-biometric")).toBeNull();
      expect(mockedBiometric).not.toHaveBeenCalled();
    });

    it("prompts for biometrics first and closes on success", async () => {
      mockedOsAuth.mockResolvedValue(OS_AUTH_BIOMETRIC_ENABLED);
      mockedBiometric.mockResolvedValue(undefined);
      const onOpenChange = await renderOpen();
      expect(mockedBiometric).toHaveBeenCalledTimes(1);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("falls back to the master password quietly when the prompt is cancelled", async () => {
      mockedOsAuth.mockResolvedValue(OS_AUTH_BIOMETRIC_ENABLED);
      mockedBiometric.mockRejectedValue({ kind: "cancelled", message: "cancelled" });
      const onOpenChange = await renderOpen();
      expect(mockedBiometric).toHaveBeenCalledTimes(1);
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(query("unlock-dialog-error")).toBeNull();
      expect(query("unlock-dialog-input")).not.toBeNull();
      // Retry is offered, and prompts again.
      expect(query("unlock-dialog-biometric")?.textContent).toContain("Touch ID");
      await act(async () => {
        (query("unlock-dialog-biometric") as HTMLButtonElement).click();
      });
      expect(mockedBiometric).toHaveBeenCalledTimes(2);
    });

    it("explains an invalidated enrollment and keeps the password path", async () => {
      mockedOsAuth.mockResolvedValue(OS_AUTH_BIOMETRIC_ENABLED);
      mockedBiometric.mockRejectedValue({
        kind: "invalidated",
        message:
          "Your fingerprints or face data have changed. Biometric unlock has been turned off.",
      });
      await renderOpen();
      expect(query("unlock-dialog-error")?.textContent).toMatch(/turned off/);
      expect(query("unlock-dialog-input")).not.toBeNull();
      // The capability is re-read so the stale button disappears.
      expect(mockedOsAuth.mock.calls.length).toBeGreaterThan(1);
    });
  });
});

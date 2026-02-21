import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { MasterPasswordSetup, calculatePasswordStrength } from "./MasterPasswordSetup";

vi.mock("@/services/api", () => ({
  setupMasterPassword: vi.fn(),
  changeMasterPassword: vi.fn(),
}));

import { setupMasterPassword, changeMasterPassword } from "@/services/api";

const mockedSetup = vi.mocked(setupMasterPassword);
const mockedChange = vi.mocked(changeMasterPassword);

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function setInputValue(testId: string, value: string) {
  const input = query(testId) as HTMLInputElement;
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )!.set!;
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("calculatePasswordStrength", () => {
  it("returns weak for empty string", () => {
    expect(calculatePasswordStrength("")).toBe("weak");
  });

  it("returns weak for short password", () => {
    expect(calculatePasswordStrength("abc")).toBe("weak");
  });

  it("returns weak for long password with only one character type", () => {
    expect(calculatePasswordStrength("abcdefgh")).toBe("weak");
  });

  it("returns medium for 8+ chars with 2 character types", () => {
    expect(calculatePasswordStrength("abcdefG1")).toBe("medium");
  });

  it("returns strong for 12+ chars with 3+ character types", () => {
    expect(calculatePasswordStrength("abcdefGHIJ12")).toBe("strong");
  });

  it("returns strong for 12+ chars with symbols", () => {
    expect(calculatePasswordStrength("Abc123!@#xyz")).toBe("strong");
  });
});

describe("MasterPasswordSetup", () => {
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

  describe("setup mode", () => {
    it("shows correct title and warning", () => {
      act(() => {
        root.render(
          <MasterPasswordSetup open={true} onOpenChange={vi.fn()} mode="setup" />
        );
      });

      expect(document.querySelector(".master-pw__title")?.textContent).toBe("Set Master Password");
      expect(query("master-pw-warning")).not.toBeNull();
    });

    it("does not show current password field", () => {
      act(() => {
        root.render(
          <MasterPasswordSetup open={true} onOpenChange={vi.fn()} mode="setup" />
        );
      });

      expect(query("master-pw-current")).toBeNull();
      expect(query("master-pw-new")).not.toBeNull();
      expect(query("master-pw-confirm")).not.toBeNull();
    });

    it("submit is disabled when passwords are invalid", () => {
      act(() => {
        root.render(
          <MasterPasswordSetup open={true} onOpenChange={vi.fn()} mode="setup" />
        );
      });

      const submitBtn = query("master-pw-submit") as HTMLButtonElement;
      expect(submitBtn.disabled).toBe(true);
    });

    it("shows mismatch hint when passwords differ", () => {
      act(() => {
        root.render(
          <MasterPasswordSetup open={true} onOpenChange={vi.fn()} mode="setup" />
        );
      });

      act(() => {
        setInputValue("master-pw-new", "Password123!");
        setInputValue("master-pw-confirm", "Different");
      });

      expect(query("master-pw-mismatch")).not.toBeNull();
      expect(query("master-pw-mismatch")!.textContent).toBe("Passwords do not match.");
    });

    it("calls setupMasterPassword on submit", async () => {
      mockedSetup.mockResolvedValueOnce(undefined);
      const onOpenChange = vi.fn();

      act(() => {
        root.render(
          <MasterPasswordSetup open={true} onOpenChange={onOpenChange} mode="setup" />
        );
      });

      act(() => {
        setInputValue("master-pw-new", "MyPassword1!");
        setInputValue("master-pw-confirm", "MyPassword1!");
      });

      const submitBtn = query("master-pw-submit") as HTMLButtonElement;
      await act(async () => {
        submitBtn.click();
      });

      expect(mockedSetup).toHaveBeenCalledWith("MyPassword1!");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  describe("change mode", () => {
    it("shows correct title and current password field", () => {
      act(() => {
        root.render(
          <MasterPasswordSetup open={true} onOpenChange={vi.fn()} mode="change" />
        );
      });

      expect(document.querySelector(".master-pw__title")?.textContent).toBe(
        "Change Master Password"
      );
      expect(query("master-pw-current")).not.toBeNull();
      expect(query("master-pw-warning")).toBeNull();
    });

    it("calls changeMasterPassword on submit", async () => {
      mockedChange.mockResolvedValueOnce(undefined);
      const onOpenChange = vi.fn();

      act(() => {
        root.render(
          <MasterPasswordSetup open={true} onOpenChange={onOpenChange} mode="change" />
        );
      });

      act(() => {
        setInputValue("master-pw-current", "OldPassword1!");
        setInputValue("master-pw-new", "NewPassword1!");
        setInputValue("master-pw-confirm", "NewPassword1!");
      });

      const submitBtn = query("master-pw-submit") as HTMLButtonElement;
      await act(async () => {
        submitBtn.click();
      });

      expect(mockedChange).toHaveBeenCalledWith("OldPassword1!", "NewPassword1!");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("shows error on API failure", async () => {
      mockedChange.mockRejectedValueOnce(new Error("Wrong current password"));
      const onOpenChange = vi.fn();

      act(() => {
        root.render(
          <MasterPasswordSetup open={true} onOpenChange={onOpenChange} mode="change" />
        );
      });

      act(() => {
        setInputValue("master-pw-current", "WrongPass1!");
        setInputValue("master-pw-new", "NewPassword1!");
        setInputValue("master-pw-confirm", "NewPassword1!");
      });

      const submitBtn = query("master-pw-submit") as HTMLButtonElement;
      await act(async () => {
        submitBtn.click();
      });

      expect(query("master-pw-error")).not.toBeNull();
      expect(query("master-pw-error")!.textContent).toBe("Wrong current password");
      expect(onOpenChange).not.toHaveBeenCalled();
    });
  });

  it("shows strength indicator when typing", () => {
    act(() => {
      root.render(
        <MasterPasswordSetup open={true} onOpenChange={vi.fn()} mode="setup" />
      );
    });

    // No strength indicator initially
    expect(query("master-pw-strength")).toBeNull();

    act(() => {
      setInputValue("master-pw-new", "abc");
    });

    expect(query("master-pw-strength")).not.toBeNull();
  });

  it("cancel calls onOpenChange(false)", () => {
    const onOpenChange = vi.fn();

    act(() => {
      root.render(
        <MasterPasswordSetup open={true} onOpenChange={onOpenChange} mode="setup" />
      );
    });

    const cancelBtn = query("master-pw-cancel") as HTMLButtonElement;
    act(() => {
      cancelBtn.click();
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui";
import { KeyPathInput } from "./KeyPathInput";
import { open } from "@tauri-apps/plugin-dialog";

// Mock Tauri dialog (Browse button)
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

// Mutable suggestion state so individual tests can seed the dropdown with key
// files (the interaction suite) or leave it empty (the validation-hint suite).
const sshKeyState = vi.hoisted(() => ({
  keyFiles: [] as { name: string; path: string }[],
  sshDirPath: "/home/u/.ssh" as string | null,
}));
vi.mock("@/hooks/useSshKeyFiles", () => ({
  useSshKeyFiles: () => sshKeyState,
}));

const validateSshKey = vi.fn();
vi.mock("@/services/api", () => ({
  validateSshKey: (path: string) => validateSshKey(path),
}));

const mockedOpen = vi.mocked(open);

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

const HINT = "field-keyPath-key-path-validation";

function renderInput(value: string) {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <KeyPathInput value={value} onChange={() => {}} testIdPrefix="field-keyPath" />
      </TooltipProvider>
    );
  });
}

describe("KeyPathInput validation hint (#896 / PR #204)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    validateSshKey.mockReset();
    // This suite is about the validation hint: keep the dropdown empty/inert.
    sshKeyState.keyFiles = [];
    sshKeyState.sshDirPath = "/home/u/.ssh";
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("hosts the combobox on the shared ui/Input primitive without losing its aria roles", () => {
    renderInput("");
    const field = query("field-keyPath-key-path-input") as HTMLInputElement | null;
    // Migrated to ui/Input: the primitive class is present and every combobox
    // attribute the type-ahead relies on is still forwarded through it.
    expect(field?.className).toContain("ui-input");
    expect(field?.getAttribute("role")).toBe("combobox");
    expect(field?.getAttribute("aria-autocomplete")).toBe("list");
    expect(field?.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders a 'valid' hint after the debounce for a private key", async () => {
    validateSshKey.mockResolvedValue({
      status: "valid",
      message: "OpenSSH private key detected.",
      keyType: "OpenSSH",
    });
    vi.useFakeTimers();
    renderInput("/home/u/.ssh/id_ed25519");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(validateSshKey).toHaveBeenCalledWith("/home/u/.ssh/id_ed25519");
    const hint = query(HINT);
    expect(hint?.textContent).toBe("OpenSSH private key detected.");
    expect(hint?.className).toContain("settings-form__hint--valid");
  });

  it("renders a 'warning' hint for a public key (.pub)", async () => {
    validateSshKey.mockResolvedValue({
      status: "warning",
      message: "This looks like a public key (.pub).",
      keyType: "",
    });
    vi.useFakeTimers();
    renderInput("/home/u/.ssh/id_ed25519.pub");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    const hint = query(HINT);
    expect(hint?.textContent).toContain("public key");
    expect(hint?.className).toContain("settings-form__hint--warning");
  });

  it("renders an 'error' hint for a missing file", async () => {
    validateSshKey.mockResolvedValue({
      status: "error",
      message: "File not found.",
      keyType: "",
    });
    vi.useFakeTimers();
    renderInput("/nonexistent/key");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    const hint = query(HINT);
    expect(hint?.textContent).toBe("File not found.");
    expect(hint?.className).toContain("settings-form__hint--error");
  });

  it("shows no hint and does not call the backend for an empty value", async () => {
    vi.useFakeTimers();
    renderInput("");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(validateSshKey).not.toHaveBeenCalled();
    expect(query(HINT)).toBeNull();
  });

  it("treats a whitespace-only value as empty — no validation, no valid hint (security invariant)", async () => {
    // A path of only spaces is not a real key; the component must not fire a
    // backend check for it nor surface any "valid" affirmation. This locks the
    // TFE-009 invariant that an empty/blank key path is never silently accepted.
    vi.useFakeTimers();
    renderInput("   ");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(validateSshKey).not.toHaveBeenCalled();
    expect(query(HINT)).toBeNull();
  });

  it("clears a stale hint and drops the pending check when the value becomes empty", async () => {
    validateSshKey.mockResolvedValue({
      status: "valid",
      message: "OpenSSH private key detected.",
      keyType: "OpenSSH",
    });
    vi.useFakeTimers();
    renderInput("/home/u/.ssh/id_ed25519");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(query(HINT)?.textContent).toBe("OpenSSH private key detected.");

    // Re-render with an empty value: the effect's empty-path branch must cancel
    // the pending validation and wipe the hint immediately.
    renderInput("");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(query(HINT)).toBeNull();
  });

  it("surfaces no hint when the backend validation call rejects", async () => {
    validateSshKey.mockRejectedValue(new Error("backend down"));
    vi.useFakeTimers();
    renderInput("/home/u/.ssh/id_ed25519");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(validateSshKey).toHaveBeenCalledWith("/home/u/.ssh/id_ed25519");
    expect(query(HINT)).toBeNull();
  });
});

// --- Combobox / browse / keyboard-navigation branches (dropdown populated) ---

const KEY_FILES = [
  { name: "id_ed25519", path: "/home/u/.ssh/id_ed25519" },
  { name: "id_rsa", path: "/home/u/.ssh/id_rsa" },
];

function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("KeyPathInput combobox interactions", () => {
  let onChange: Mock<(value: string) => void>;

  function render(value: string, extraProps: Record<string, unknown> = {}) {
    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <KeyPathInput
            value={value}
            onChange={onChange}
            testIdPrefix="field-keyPath"
            {...extraProps}
          />
        </TooltipProvider>
      );
    });
  }

  function input() {
    return query("field-keyPath-key-path-input") as HTMLInputElement;
  }
  function focusInput() {
    act(() => {
      input().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
  }
  function keydown(key: string) {
    act(() => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    validateSshKey.mockReset();
    validateSshKey.mockResolvedValue(null);
    mockedOpen.mockReset();
    mockedOpen.mockResolvedValue(null);
    sshKeyState.keyFiles = [...KEY_FILES];
    sshKeyState.sshDirPath = "/home/u/.ssh";
    onChange = vi.fn<(value: string) => void>();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("opens the dropdown on focus and lists every key file", () => {
    render("");
    expect(query("field-keyPath-key-path-dropdown")).toBeNull();
    focusInput();
    const dropdown = query("field-keyPath-key-path-dropdown");
    expect(dropdown).not.toBeNull();
    expect(query("field-keyPath-key-path-option-0")?.textContent).toContain("id_ed25519");
    expect(query("field-keyPath-key-path-option-1")?.textContent).toContain("id_rsa");
    expect(input().getAttribute("aria-expanded")).toBe("true");
  });

  it("does not open the dropdown on focus when no key files are available", () => {
    sshKeyState.keyFiles = [];
    render("");
    focusInput();
    expect(query("field-keyPath-key-path-dropdown")).toBeNull();
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the dropdown while typing and filters by substring", () => {
    render("");
    // Typing a substring opens the dropdown (isOpen was false, keyFiles > 0)
    // and reports the raw value upward.
    act(() => setNativeValue(input(), "id_ed"));
    expect(onChange).toHaveBeenCalledWith("id_ed");
  });

  it("filters the visible options by the controlled value", () => {
    render("rsa");
    focusInput();
    // Only id_rsa matches "rsa".
    expect(query("field-keyPath-key-path-option-0")?.textContent).toContain("id_rsa");
    expect(query("field-keyPath-key-path-option-1")).toBeNull();
  });

  it("ArrowDown highlights and Enter accepts the highlighted key file", () => {
    render("");
    focusInput();
    keydown("ArrowDown");
    expect(query("field-keyPath-key-path-option-0")?.getAttribute("aria-selected")).toBe("true");
    keydown("Enter");
    expect(onChange).toHaveBeenCalledWith("/home/u/.ssh/id_ed25519");
    // Accepting closes the dropdown.
    expect(query("field-keyPath-key-path-dropdown")).toBeNull();
  });

  it("ArrowDown wraps to the top and ArrowUp wraps to the bottom", () => {
    render("");
    focusInput();
    keydown("ArrowDown"); // -> 0
    keydown("ArrowDown"); // -> 1 (last)
    keydown("ArrowDown"); // wraps -> 0
    expect(query("field-keyPath-key-path-option-0")?.getAttribute("aria-selected")).toBe("true");
    keydown("ArrowUp"); // wraps -> 1 (last)
    expect(query("field-keyPath-key-path-option-1")?.getAttribute("aria-selected")).toBe("true");
  });

  it("Tab auto-accepts when exactly one option matches", () => {
    render("id_ed"); // filters to the single id_ed25519 entry
    focusInput();
    keydown("Tab");
    expect(onChange).toHaveBeenCalledWith("/home/u/.ssh/id_ed25519");
  });

  it("Tab accepts the highlighted option when one is highlighted", () => {
    render("");
    focusInput();
    keydown("ArrowDown"); // highlight index 0
    keydown("Tab");
    expect(onChange).toHaveBeenCalledWith("/home/u/.ssh/id_ed25519");
  });

  it("Escape closes the dropdown without changing the value", () => {
    render("");
    focusInput();
    expect(query("field-keyPath-key-path-dropdown")).not.toBeNull();
    keydown("Escape");
    expect(query("field-keyPath-key-path-dropdown")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clicking an option accepts it (mousedown, before blur)", () => {
    render("");
    focusInput();
    const option = query("field-keyPath-key-path-option-1") as HTMLElement;
    act(() => {
      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("/home/u/.ssh/id_rsa");
    expect(query("field-keyPath-key-path-dropdown")).toBeNull();
  });

  it("blurring outside the wrapper closes the dropdown", () => {
    render("");
    focusInput();
    expect(query("field-keyPath-key-path-dropdown")).not.toBeNull();
    act(() => {
      input().dispatchEvent(
        new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body })
      );
    });
    expect(query("field-keyPath-key-path-dropdown")).toBeNull();
  });

  it("keeps the dropdown open when focus moves to a dropdown item", () => {
    render("");
    focusInput();
    const option = query("field-keyPath-key-path-option-0") as HTMLElement;
    act(() => {
      input().dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: option }));
    });
    // relatedTarget is inside the wrapper, so blur is ignored and it stays open.
    expect(query("field-keyPath-key-path-dropdown")).not.toBeNull();
  });

  it("Browse dialog success reports the chosen path upward", async () => {
    mockedOpen.mockResolvedValueOnce("/picked/id_ed25519");
    render("");
    const browse = query("field-keyPath-key-path-browse") as HTMLButtonElement;
    await act(async () => {
      browse.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mockedOpen).toHaveBeenCalledWith(
      expect.objectContaining({ multiple: false, defaultPath: "/home/u/.ssh" })
    );
    expect(onChange).toHaveBeenCalledWith("/picked/id_ed25519");
  });

  it("Browse dialog cancel leaves the value untouched (never accepts an empty pick)", async () => {
    mockedOpen.mockResolvedValueOnce(null);
    render("");
    const browse = query("field-keyPath-key-path-browse") as HTMLButtonElement;
    await act(async () => {
      browse.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mockedOpen).toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("forwards aria-describedby and aria-invalid to the combobox input", () => {
    render("", { "aria-describedby": "err-1", "aria-invalid": true });
    expect(input().getAttribute("aria-describedby")).toBe("err-1");
    expect(input().getAttribute("aria-invalid")).toBe("true");
  });
});

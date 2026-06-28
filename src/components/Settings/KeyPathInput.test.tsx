import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { KeyPathInput } from "./KeyPathInput";

// Mock Tauri dialog (Browse button)
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

// Keep the suggestion dropdown empty/inert — this suite is about the validation hint.
vi.mock("@/hooks/useSshKeyFiles", () => ({
  useSshKeyFiles: () => ({ keyFiles: [], sshDirPath: "/home/u/.ssh" }),
}));

const validateSshKey = vi.fn();
vi.mock("@/services/api", () => ({
  validateSshKey: (path: string) => validateSshKey(path),
}));

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

const HINT = "field-keyPath-key-path-validation";

function renderInput(value: string) {
  act(() => {
    root.render(<KeyPathInput value={value} onChange={() => {}} testIdPrefix="field-keyPath" />);
  });
}

describe("KeyPathInput validation hint (#896 / PR #204)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    validateSshKey.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
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
});

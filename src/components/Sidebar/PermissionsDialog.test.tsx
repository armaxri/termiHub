import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { PermissionsDialog } from "./PermissionsDialog";
import type { FileEntry } from "@/types/connection";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

function makeEntry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    name: "script.sh",
    path: "/home/user/script.sh",
    isDirectory: false,
    size: 10,
    modified: "2026-01-01T00:00:00Z",
    permissions: "rw-r--r--",
    writable: true,
    isSymlink: false,
    symlinkTarget: null,
    ...overrides,
  } as FileEntry;
}

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("PermissionsDialog", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("pre-fills the octal input and preview from the entry's mode", () => {
    render(<PermissionsDialog entry={makeEntry()} onApply={vi.fn()} onClose={vi.fn()} />);

    const octal = document.body.querySelector<HTMLInputElement>(
      '[data-testid="permissions-octal"]'
    );
    expect(octal?.value).toBe("644");

    const preview = document.body.querySelector('[data-testid="permissions-preview"]');
    expect(preview?.textContent).toBe("rw-r--r--");
  });

  it("applies the edited octal mode and closes", async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<PermissionsDialog entry={makeEntry()} onApply={onApply} onClose={onClose} />);

    const octal = document.body.querySelector<HTMLInputElement>(
      '[data-testid="permissions-octal"]'
    )!;
    act(() => {
      setInputValue(octal, "755");
    });

    // Preview reflects the new mode.
    const preview = document.body.querySelector('[data-testid="permissions-preview"]');
    expect(preview?.textContent).toBe("rwxr-xr-x");

    const apply = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="permissions-apply"]'
    )!;
    await act(async () => {
      apply.click();
    });

    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ name: "script.sh" }), 0o755);
    expect(onClose).toHaveBeenCalled();
  });

  it("disables Apply and marks the input invalid on a bad octal value", () => {
    render(<PermissionsDialog entry={makeEntry()} onApply={vi.fn()} onClose={vi.fn()} />);

    const octal = document.body.querySelector<HTMLInputElement>(
      '[data-testid="permissions-octal"]'
    )!;
    act(() => {
      setInputValue(octal, "8");
    });

    const apply = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="permissions-apply"]'
    )!;
    expect(apply.disabled).toBe(true);
    expect(octal.getAttribute("aria-invalid")).toBe("true");
  });
});

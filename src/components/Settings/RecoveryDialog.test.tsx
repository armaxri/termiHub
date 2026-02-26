import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { RecoveryDialog } from "./RecoveryDialog";
import { RecoveryWarning } from "@/types/connection";

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

describe("RecoveryDialog", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("does not render when warnings are empty", () => {
    act(() => {
      root.render(<RecoveryDialog open={true} onOpenChange={vi.fn()} warnings={[]} />);
    });

    expect(query("recovery-dialog")).toBeNull();
  });

  it("renders warning content when open", () => {
    const warnings: RecoveryWarning[] = [
      {
        fileName: "connections.json",
        message: "Removed corrupt connection entry at index 1.",
        details: null,
      },
    ];

    act(() => {
      root.render(<RecoveryDialog open={true} onOpenChange={vi.fn()} warnings={warnings} />);
    });

    const dialog = query("recovery-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("connections.json");
    expect(dialog!.textContent).toContain("Removed corrupt connection entry at index 1.");
  });

  it("calls onOpenChange when OK button is clicked", () => {
    const onOpenChange = vi.fn();
    const warnings: RecoveryWarning[] = [
      {
        fileName: "settings.json",
        message: "Settings file was corrupt.",
        details: null,
      },
    ];

    act(() => {
      root.render(<RecoveryDialog open={true} onOpenChange={onOpenChange} warnings={warnings} />);
    });

    const closeBtn = query("recovery-dialog-close");
    expect(closeBtn).not.toBeNull();
    act(() => {
      closeBtn!.click();
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows technical details when present", () => {
    const warnings: RecoveryWarning[] = [
      {
        fileName: "connections.json",
        message: "File was corrupt.",
        details: "expected value at line 1 column 1",
      },
    ];

    act(() => {
      root.render(<RecoveryDialog open={true} onOpenChange={vi.fn()} warnings={warnings} />);
    });

    const dialog = query("recovery-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("Technical details");
    expect(dialog!.textContent).toContain("expected value at line 1 column 1");
  });
});

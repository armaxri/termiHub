import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TransferControls } from "./TransferControls";
import { TooltipProvider } from "@/components/ui";
import type { TransferQueueState } from "@/types/transfer";

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function handlers() {
  return {
    onPause: vi.fn(),
    onResume: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    onRemove: vi.fn(),
  };
}

function render(state: TransferQueueState, h = handlers()) {
  act(() => {
    root.render(
      <TooltipProvider>
        <TransferControls state={state} {...h} />
      </TooltipProvider>
    );
  });
  return h;
}

describe("TransferControls", () => {
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

  it("active state shows Pause + Cancel only", () => {
    render("active");
    expect(query("transfer-pause")).not.toBeNull();
    expect(query("transfer-cancel")).not.toBeNull();
    expect(query("transfer-resume")).toBeNull();
    expect(query("transfer-retry")).toBeNull();
    expect(query("transfer-remove")).toBeNull();
  });

  it("paused state shows Resume + Cancel only", () => {
    render("paused");
    expect(query("transfer-resume")).not.toBeNull();
    expect(query("transfer-cancel")).not.toBeNull();
    expect(query("transfer-pause")).toBeNull();
    expect(query("transfer-remove")).toBeNull();
  });

  it("queued state shows only Cancel", () => {
    render("queued");
    expect(query("transfer-cancel")).not.toBeNull();
    expect(query("transfer-pause")).toBeNull();
    expect(query("transfer-resume")).toBeNull();
    expect(query("transfer-retry")).toBeNull();
    expect(query("transfer-remove")).toBeNull();
  });

  it("completed state shows only Remove", () => {
    render("completed");
    expect(query("transfer-remove")).not.toBeNull();
    expect(query("transfer-cancel")).toBeNull();
    expect(query("transfer-retry")).toBeNull();
    expect(query("transfer-pause")).toBeNull();
  });

  it("failed state shows Retry + Remove", () => {
    render("failed");
    expect(query("transfer-retry")).not.toBeNull();
    expect(query("transfer-remove")).not.toBeNull();
    expect(query("transfer-cancel")).toBeNull();
  });

  it("cancelled state shows Retry + Remove", () => {
    render("cancelled");
    expect(query("transfer-retry")).not.toBeNull();
    expect(query("transfer-remove")).not.toBeNull();
    expect(query("transfer-pause")).toBeNull();
  });

  it("routes each control click to its matching handler", () => {
    const h = render("active");
    act(() => query("transfer-pause")?.click());
    expect(h.onPause).toHaveBeenCalledTimes(1);
    act(() => query("transfer-cancel")?.click());
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it("routes Retry and Remove on a failed row to their handlers", () => {
    const h = render("failed");
    act(() => query("transfer-retry")?.click());
    expect(h.onRetry).toHaveBeenCalledTimes(1);
    act(() => query("transfer-remove")?.click());
    expect(h.onRemove).toHaveBeenCalledTimes(1);
  });
});

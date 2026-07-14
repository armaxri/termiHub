import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TransferEntryRow } from "./TransferEntry";
import { TooltipProvider } from "@/components/ui";
import type { TransferEntry } from "@/types/transfer";

function entry(overrides: Partial<TransferEntry> = {}): TransferEntry {
  return {
    id: "t1",
    sessionId: "sess-a",
    direction: "download",
    name: "report.pdf",
    path: "/pub/report.pdf",
    state: "active",
    transferred: 78,
    totalBytes: 100,
    percent: 78,
    speedBytesPerSec: 23 * 1024,
    updatedAt: 0,
    ...overrides,
  };
}

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

function render(e: TransferEntry, h = handlers()) {
  act(() => {
    root.render(
      <TooltipProvider>
        <TransferEntryRow entry={e} {...h} />
      </TooltipProvider>
    );
  });
  return h;
}

describe("TransferEntryRow", () => {
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

  it("renders name, path, percent, and throughput for an active transfer", () => {
    render(entry());
    expect(query("transfer-row")?.textContent).toContain("report.pdf");
    expect(container.textContent).toContain("/pub/report.pdf");
    expect(container.textContent).toContain("78%");
    expect(container.textContent).toContain("23 KB/s");
  });

  it("active state shows Pause + Cancel", () => {
    render(entry({ state: "active" }));
    expect(query("transfer-pause")).not.toBeNull();
    expect(query("transfer-cancel")).not.toBeNull();
    expect(query("transfer-resume")).toBeNull();
    expect(query("transfer-retry")).toBeNull();
    expect(query("transfer-remove")).toBeNull();
  });

  it("paused state shows Resume + Cancel and a paused status", () => {
    render(entry({ state: "paused", percent: 31 }));
    expect(query("transfer-resume")).not.toBeNull();
    expect(query("transfer-cancel")).not.toBeNull();
    expect(query("transfer-pause")).toBeNull();
    expect(query("transfer-row-status")?.textContent?.toLowerCase()).toContain("paused");
  });

  it("queued state shows only Cancel and a queued status", () => {
    render(entry({ state: "queued", percent: null, transferred: 0, speedBytesPerSec: null }));
    expect(query("transfer-cancel")).not.toBeNull();
    expect(query("transfer-pause")).toBeNull();
    expect(query("transfer-resume")).toBeNull();
    expect(query("transfer-row-status")?.textContent?.toLowerCase()).toContain("queued");
  });

  it("completed state shows 100% + done status and only a Remove control", () => {
    render(entry({ state: "completed", percent: 100, transferred: 100, speedBytesPerSec: null }));
    expect(container.textContent).toContain("100%");
    expect(query("transfer-row-status")?.textContent?.toLowerCase()).toContain("done");
    expect(query("transfer-remove")).not.toBeNull();
    expect(query("transfer-pause")).toBeNull();
    expect(query("transfer-cancel")).toBeNull();
  });

  it("failed state shows the error, attempt counter, and Retry + Remove", () => {
    render(
      entry({
        state: "failed",
        percent: 62,
        error: "connection reset",
        attempt: 2,
        maxAttempts: 3,
        speedBytesPerSec: null,
      })
    );
    const status = query("transfer-row-status");
    expect(status?.textContent?.toLowerCase()).toContain("failed");
    expect(status?.textContent).toContain("2/3");
    expect(query("transfer-retry")).not.toBeNull();
    expect(query("transfer-remove")).not.toBeNull();
  });

  it("cancelled state shows a cancelled status and Retry + Remove", () => {
    render(entry({ state: "cancelled", speedBytesPerSec: null }));
    expect(query("transfer-row-status")?.textContent?.toLowerCase()).toContain("cancelled");
    expect(query("transfer-retry")).not.toBeNull();
    expect(query("transfer-remove")).not.toBeNull();
  });

  it("invokes the matching handler with the transfer id when a control is clicked", () => {
    const h = render(entry({ state: "active" }));
    act(() => {
      query("transfer-pause")?.click();
    });
    expect(h.onPause).toHaveBeenCalledWith("t1");

    act(() => {
      query("transfer-cancel")?.click();
    });
    expect(h.onCancel).toHaveBeenCalledWith("t1");
  });

  it("Remove on a terminal row invokes onRemove with the id", () => {
    const h = render(entry({ state: "completed" }));
    act(() => {
      query("transfer-remove")?.click();
    });
    expect(h.onRemove).toHaveBeenCalledWith("t1");
  });
});

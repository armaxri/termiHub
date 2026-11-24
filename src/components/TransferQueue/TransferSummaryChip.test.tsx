import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { TransferEntry } from "@/types/transfer";

const view = vi.hoisted(() => ({ queue: {} as Record<string, unknown> }));

vi.mock("@/store/useProjectedTransfers", () => ({
  useProjectedTransfers: () => view,
}));

import { TransferSummaryChip } from "./TransferSummaryChip";
import { isTransferSummaryShown, resetTransferSummaries } from "./transferSummaryVisibility";
import { TooltipProvider } from "@/components/ui";

let container: HTMLDivElement;
let root: Root;

function entry(id: string, sessionId: string, state: TransferEntry["state"]): TransferEntry {
  return { id, sessionId, state } as TransferEntry;
}

function render(sessionId: string | null) {
  act(() =>
    root.render(
      <TooltipProvider>
        <TransferSummaryChip sessionId={sessionId} />
      </TooltipProvider>
    )
  );
}

beforeEach(() => {
  resetTransferSummaries();
  view.queue = {};
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("TransferSummaryChip — the one transfer report on screen (#5859)", () => {
  it("marks its session's summary shown while it renders, and releases it on unmount", () => {
    view.queue = { t1: entry("t1", "sess-a", "completed") };
    render("sess-a");
    expect(container.textContent).toContain("1 transfer done");
    expect(isTransferSummaryShown("sess-a")).toBe(true);

    act(() => root.unmount());
    root = createRoot(container);
    expect(isTransferSummaryShown("sess-a")).toBe(false);
  });

  it("marks nothing when the session has no transfers to summarise", () => {
    view.queue = { t1: entry("t1", "sess-b", "completed") };
    render("sess-a");
    expect(container.textContent).toBe("");
    expect(isTransferSummaryShown("sess-a")).toBe(false);
  });

  it("marks nothing without a session", () => {
    render(null);
    expect(isTransferSummaryShown("sess-a")).toBe(false);
  });
});

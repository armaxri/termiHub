import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { TransferEntry } from "@/types/transfer";

const view = vi.hoisted(() => ({ queue: {} as Record<string, unknown> }));

vi.mock("@/store/useProjectedTransfers", () => ({
  useProjectedTransfers: () => view,
}));

vi.mock("@/services/api", () => ({
  localOpenFolder: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  };
});

import { localOpenFolder } from "@/services/api";
import { TooltipProvider, toast } from "@/components/ui";
import { fileManagerActionLabel } from "@/utils/platform";
import { latestRevealableDownload, revealDownload, revealableDownloadPath } from "./revealDownload";
import { TransferEntryRow } from "./TransferEntry";
import { TransferSummaryChip } from "./TransferSummaryChip";
import { resetTransferSummaries } from "./transferSummaryVisibility";

function row(id: string, overrides: Partial<TransferEntry> = {}): TransferEntry {
  return {
    id,
    sessionId: "sess-a",
    direction: "download",
    name: "copy-me.txt",
    path: "/remote/copy-me.txt",
    localPath: "/Users/me/Downloads/copy-me.txt",
    state: "completed",
    transferred: 10,
    totalBytes: 10,
    percent: 100,
    speedBytesPerSec: null,
    etaSeconds: null,
    updatedAt: 1,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode) {
  act(() => root.render(<TooltipProvider>{node}</TooltipProvider>));
}

function byTestId(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

const flush = () => act(async () => await Promise.resolve());

beforeEach(() => {
  resetTransferSummaries();
  view.queue = {};
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("revealableDownloadPath (#5834)", () => {
  it("offers a finished download whose destination is known", () => {
    expect(revealableDownloadPath(row("t1"))).toBe("/Users/me/Downloads/copy-me.txt");
  });

  it("offers nothing for an upload, an unfinished or failed row, or an unknown destination", () => {
    expect(revealableDownloadPath(row("t1", { direction: "upload" }))).toBeNull();
    expect(revealableDownloadPath(row("t1", { state: "active" }))).toBeNull();
    expect(revealableDownloadPath(row("t1", { state: "failed" }))).toBeNull();
    expect(revealableDownloadPath(row("t1", { localPath: undefined }))).toBeNull();
  });

  it("picks the download that finished last", () => {
    const older = row("a", { updatedAt: 1, localPath: "/d/a.txt" });
    const newer = row("b", { updatedAt: 5, localPath: "/d/b.txt" });
    const upload = row("c", { updatedAt: 9, direction: "upload" });
    expect(latestRevealableDownload([older, newer, upload])?.id).toBe("b");
    expect(latestRevealableDownload([upload])).toBeNull();
  });
});

describe("revealDownload", () => {
  it("opens the folder holding the file", () => {
    revealDownload("/Users/me/Downloads/copy-me.txt");
    expect(localOpenFolder).toHaveBeenCalledWith("/Users/me/Downloads");
  });

  it("reports a folder that cannot be opened", async () => {
    vi.mocked(localOpenFolder).mockRejectedValueOnce(new Error("not found"));
    revealDownload("/gone/copy-me.txt");
    await flush();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("not found"));
  });
});

describe("Transfers panel row — reveal a finished download", () => {
  const handlers = {
    onPause: vi.fn(),
    onResume: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    onRemove: vi.fn(),
  };

  it("shows the platform-named action on a finished download and reveals it", () => {
    render(<TransferEntryRow entry={row("t1")} {...handlers} />);
    const reveal = byTestId("transfer-reveal");
    expect(reveal?.getAttribute("aria-label")).toBe(fileManagerActionLabel());
    act(() => reveal?.click());
    expect(localOpenFolder).toHaveBeenCalledWith("/Users/me/Downloads");
  });

  it("has no reveal on a failed download, which keeps Retry", () => {
    render(<TransferEntryRow entry={row("t1", { state: "failed" })} {...handlers} />);
    expect(byTestId("transfer-reveal")).toBeNull();
    expect(byTestId("transfer-retry")).not.toBeNull();
  });

  it("has no reveal on an upload", () => {
    render(<TransferEntryRow entry={row("t1", { direction: "upload" })} {...handlers} />);
    expect(byTestId("transfer-reveal")).toBeNull();
  });
});

describe("File browser summary line — reveal the download that just finished", () => {
  it("offers the reveal beside the done line and opens the file's folder", () => {
    view.queue = { t1: row("t1") };
    render(<TransferSummaryChip sessionId="sess-a" />);
    expect(byTestId("file-browser-transfer-summary")?.textContent).toContain("1 transfer done");
    const reveal = byTestId("file-browser-transfer-reveal");
    expect(reveal?.textContent).toContain(fileManagerActionLabel());
    expect(reveal?.getAttribute("aria-label")).toBe(`${fileManagerActionLabel()}: copy-me.txt`);
    act(() => reveal?.click());
    expect(localOpenFolder).toHaveBeenCalledWith("/Users/me/Downloads");
  });

  it("waits while a transfer is still running", () => {
    view.queue = { t1: row("t1"), t2: row("t2", { state: "active", localPath: "/d/x" }) };
    render(<TransferSummaryChip sessionId="sess-a" />);
    expect(byTestId("file-browser-transfer-summary")?.textContent).toContain("in progress");
    expect(byTestId("file-browser-transfer-reveal")).toBeNull();
  });

  it("offers nothing for a finished upload", () => {
    view.queue = { t1: row("t1", { direction: "upload" }) };
    render(<TransferSummaryChip sessionId="sess-a" />);
    expect(byTestId("file-browser-transfer-summary")).not.toBeNull();
    expect(byTestId("file-browser-transfer-reveal")).toBeNull();
  });

  it("still reports a failure on the line itself", () => {
    view.queue = { t1: row("t1", { state: "failed", error: "Permission denied" }) };
    render(<TransferSummaryChip sessionId="sess-a" />);
    expect(byTestId("file-browser-transfer-summary")?.textContent).toContain("1 transfer failed");
    expect(byTestId("file-browser-transfer-reveal")).toBeNull();
  });
});

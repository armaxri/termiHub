import { describe, it, expect, vi, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

vi.mock("@/services/api", () => ({
  folderPasteTakeInterrupted: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/components/ui", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(() => "loading-1"),
    dismiss: vi.fn(),
  },
}));

vi.mock("./sessionFolderPaste", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sessionFolderPaste")>();
  return { ...actual, retryInterruptedFolderPaste: vi.fn(() => Promise.resolve(true)) };
});

import { toast } from "@/components/ui";
import { folderPasteTakeInterrupted, type InterruptedFolderPaste } from "@/services/api";
import { FolderPasteEndpointUnavailable, retryInterruptedFolderPaste } from "./sessionFolderPaste";
import { retryFromNotice, useInterruptedFolderPastes } from "./useInterruptedFolderPastes";

const paste: InterruptedFolderPaste = {
  id: "p1",
  operation: "copy",
  source: { path: "/home/u/photos", label: "Local" },
  destination: { sessionId: "s", connectionId: "c", label: "web-1", path: "/srv/photos" },
  startedAtMs: 1,
};

/** The Retry action of the latest `toast.error` call. */
function lastRetryAction(): () => void {
  const calls = vi.mocked(toast.error).mock.calls;
  const opts = calls[calls.length - 1]?.[1];
  expect(opts?.action?.label).toBe("Retry");
  return opts!.action!.onClick;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useInterruptedFolderPastes (#3630)", () => {
  it("shows a persistent notice with Retry for each interrupted paste", async () => {
    vi.mocked(folderPasteTakeInterrupted).mockResolvedValue([paste]);
    const container = document.createElement("div");
    const root = createRoot(container);
    function Harness() {
      useInterruptedFolderPastes();
      return null;
    }

    await act(async () => {
      root.render(React.createElement(Harness));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    const [title, opts] = vi.mocked(toast.error).mock.calls[0];
    expect(title).toBe("Pasting “photos” did not finish");
    expect(opts?.description).toContain("web-1 (/srv/photos)");
    lastRetryAction();
    act(() => root.unmount());
  });
});

describe("retryFromNotice", () => {
  it("reports success only once the retry completed", async () => {
    await retryFromNotice(paste);
    expect(vi.mocked(retryInterruptedFolderPaste)).toHaveBeenCalledWith(paste);
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith("Finished pasting “photos”", {
      id: "loading-1",
    });
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("brings the notice back with the reason when the retry cannot run", async () => {
    vi.mocked(retryInterruptedFolderPaste).mockRejectedValueOnce(
      new FolderPasteEndpointUnavailable(paste.destination)
    );

    await retryFromNotice(paste);

    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    const [, opts] = vi.mocked(toast.error).mock.calls[0];
    expect(opts?.description).toBe("Connect to web-1 first, then retry.");
    lastRetryAction();
  });
});

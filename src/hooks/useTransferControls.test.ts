import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import React from "react";

vi.mock("@/services/api", () => ({
  transferPause: vi.fn(() => Promise.resolve(true)),
  transferResume: vi.fn(() => Promise.resolve(true)),
  transferCancel: vi.fn(() => Promise.resolve(true)),
  transferRetry: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("@/components/ui", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

import { toast } from "@/components/ui";
import { transferCancel, transferPause } from "@/services/api";
import { useTransferControls, type TransferControlHandlers } from "./useTransferControls";

/**
 * The transfer-control handlers are shared by the Transfer Queue panel and the
 * file-browser footer (UX-020): one control contract, honest FEC-004 feedback.
 */
describe("useTransferControls", () => {
  let container: HTMLDivElement;
  let root: Root;

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

  async function renderHook(): Promise<TransferControlHandlers> {
    let api: TransferControlHandlers | undefined;
    function Harness() {
      api = useTransferControls();
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    return api!;
  }

  it("cancels via transfer_cancel and toasts success on a real state change", async () => {
    const { handleCancel } = await renderHook();
    await act(async () => {
      await handleCancel("t1");
    });
    expect(vi.mocked(transferCancel)).toHaveBeenCalledWith("t1");
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith("Transfer cancelled");
    expect(vi.mocked(toast.info)).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("shows an info (not success) toast on a backend no-op", async () => {
    vi.mocked(transferCancel).mockResolvedValueOnce(false);
    const { handleCancel } = await renderHook();
    await act(async () => {
      await handleCancel("gone");
    });
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith("Transfer already finished");
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it("shows an error toast when the control command rejects", async () => {
    vi.mocked(transferCancel).mockRejectedValueOnce(new Error("session gone"));
    const { handleCancel } = await renderHook();
    await act(async () => {
      await handleCancel("t1");
    });
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Failed to cancel transfer");
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it("reports a pause no-op honestly (legacy SFTP pause returns false)", async () => {
    vi.mocked(transferPause).mockResolvedValueOnce(false);
    const { handlePause } = await renderHook();
    await act(async () => {
      await handlePause("sftp-1");
    });
    expect(vi.mocked(transferPause)).toHaveBeenCalledWith("sftp-1");
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith("Pause isn't available for this transfer");
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });
});

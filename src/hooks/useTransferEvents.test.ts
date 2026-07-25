import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A settable callback the mocked `onTransferProgress` hands the event stream to,
// so tests can drive terminal `transfer-progress` phases directly.
let emit: ((progress: TransferProgress) => void) | undefined;
// A settable callback the mocked `onSessionOwnershipChanged` hands the ownership
// push-event to, so a test can fire it directly (#1985).
let emitOwnership: (() => void) | undefined;
const unlisten = vi.fn();

vi.mock("@/services/events", () => ({
  onTransferProgress: vi.fn((cb: (progress: TransferProgress) => void) => {
    emit = cb;
    return Promise.resolve(unlisten);
  }),
  onSessionOwnershipChanged: vi.fn((cb: () => void) => {
    emitOwnership = cb;
    return Promise.resolve(unlisten);
  }),
}));

vi.mock("@/components/ui", () => ({
  toast: {
    success: vi.fn((_message: unknown, _opts?: unknown) => undefined),
    error: vi.fn((_message: unknown, _opts?: unknown) => undefined),
    info: vi.fn((_message: unknown, _opts?: unknown) => undefined),
    loading: vi.fn((_message: unknown, _opts?: unknown) => "toast-id"),
    promise: vi.fn(),
    dismiss: vi.fn((_id?: unknown) => undefined),
  },
}));

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { useTransferEvents } from "./useTransferEvents";
import { useAppStore } from "@/store/appStore";
import { toast } from "@/components/ui";
import type { TransferProgress } from "@/services/api";

function progress(overrides: Partial<TransferProgress> = {}): TransferProgress {
  return {
    transferId: "t1",
    sessionId: "sess-a",
    direction: "download",
    fileName: "file.txt",
    transferred: 0,
    total: 100,
    phase: "transferring",
    ...overrides,
  };
}

describe("useTransferEvents — terminal-phase toasts (D2, #1286)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    emit = undefined;
    emitOwnership = undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mountHook(): Promise<void> {
    function Harness() {
      useTransferEvents();
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    // The subscription is set up asynchronously inside an effect.
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("shows exactly one success toast on a completed download", async () => {
    await mountHook();

    act(() => {
      emit!(progress({ direction: "download" }));
      emit!(progress({ transferred: 100, phase: "done" }));
    });

    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.success).mock.calls[0][0]).toContain("Downloaded");
    expect(vi.mocked(toast.success).mock.calls[0][0]).toContain("file.txt");
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("refreshes the ownership map on a session-ownership-changed event, debounced (#1985)", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ refreshSessionOwners: refresh });
    await mountHook();
    // Drain the on-mount seed call and any debounce pending from earlier tests.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    refresh.mockClear();

    // The backend pushed an ownership change → the hook refreshes (debounced).
    act(() => {
      emitOwnership!();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("labels an uploaded file with 'Uploaded'", async () => {
    await mountHook();

    act(() => {
      emit!(progress({ direction: "upload", fileName: "report.pdf", phase: "done" }));
    });

    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.success).mock.calls[0][0]).toContain("Uploaded");
    expect(vi.mocked(toast.success).mock.calls[0][0]).toContain("report.pdf");
  });

  it("shows exactly one recoverable error toast using the event message on error", async () => {
    await mountHook();

    act(() => {
      emit!(progress({ phase: "error", message: "permission denied" }));
    });

    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0][0]).toContain("permission denied");
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it("falls back to a generic error message when the event carries none", async () => {
    await mountHook();

    act(() => {
      emit!(progress({ phase: "error" }));
    });

    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(toast.error).mock.calls[0][0])).toMatch(/fail/i);
  });

  it("stays quiet on a user-initiated cancel (no success/error toast)", async () => {
    await mountHook();

    act(() => {
      emit!(progress({ phase: "cancelled" }));
    });

    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("does not toast on intermediate transferring updates", async () => {
    await mountHook();

    act(() => {
      emit!(progress({ transferred: 25 }));
      emit!(progress({ transferred: 50 }));
    });

    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("still folds the terminal phase into the store (row cleared)", async () => {
    await mountHook();

    act(() => {
      emit!(progress());
    });
    expect(useAppStore.getState().transfers["t1"]).toBeDefined();

    act(() => {
      emit!(progress({ phase: "done" }));
    });
    expect(useAppStore.getState().transfers["t1"]).toBeUndefined();
  });
});

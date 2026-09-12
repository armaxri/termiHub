import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A settable callback the mocked `onTransferProgress` hands the event stream to,
// so tests can drive terminal `transfer-progress` phases directly.
let emit: ((progress: TransferProgress) => void) | undefined;
// A settable callback the mocked `onSessionOwnershipChanged` hands the ownership
// push-event to, so a test can fire it directly (#1985).
let emitOwnership: (() => void) | undefined;
const unlisten = vi.fn();
// Resolvers for the two listener-registration promises. The real
// `onTransferProgress` / `onSessionOwnershipChanged` resolve their unlisten fn
// asynchronously; deferring resolution here lets a test control the exact moment
// registration completes — in particular, unmounting *before* it resolves, to
// reproduce the FEC-017 leak where the async `setup()` had not yet assigned its
// unlisten handles when the effect tore down.
let resolveTransferReg: (() => void) | undefined;
let resolveOwnershipReg: (() => void) | undefined;

vi.mock("@/services/events", () => ({
  onTransferProgress: vi.fn((cb: (progress: TransferProgress) => void) => {
    emit = cb;
    return new Promise<() => void>((resolve) => {
      resolveTransferReg = () => resolve(unlisten);
    });
  }),
  onSessionOwnershipChanged: vi.fn((cb: () => void) => {
    emitOwnership = cb;
    return new Promise<() => void>((resolve) => {
      resolveOwnershipReg = () => resolve(unlisten);
    });
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
    resolveTransferReg = undefined;
    resolveOwnershipReg = undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // Resolve both listener-registration promises and flush the resulting
  // microtasks, so the hook has its unlisten handles in hand.
  async function resolveRegistrations(): Promise<void> {
    await act(async () => {
      resolveTransferReg?.();
      resolveOwnershipReg?.();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function mountHook(): Promise<void> {
    function Harness() {
      useTransferEvents();
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    // The subscription is set up asynchronously inside an effect.
    await resolveRegistrations();
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

describe("useTransferEvents — registration/cleanup lifecycle (FEC-017)", () => {
  function Harness() {
    useTransferEvents();
    return null;
  }

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    emit = undefined;
    emitOwnership = undefined;
    resolveTransferReg = undefined;
    resolveOwnershipReg = undefined;
    vi.clearAllMocks();
  });

  it("unlistens listeners that register after the effect has already torn down (leak guard)", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    // Mount the hook, but do NOT resolve the registration promises yet: this
    // mimics `setup()`'s awaits still being in flight.
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    // Registration has not completed, so no unlisten handle exists yet.
    expect(unlisten).not.toHaveBeenCalled();

    // Tear the effect down before the awaits resolve.
    await act(async () => {
      root.unmount();
    });

    // Now the two registrations resolve — late, after teardown. Each must be
    // immediately unlistened so the listeners do not leak past the hook's life.
    await act(async () => {
      resolveTransferReg?.();
      resolveOwnershipReg?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(unlisten).toHaveBeenCalledTimes(2);

    container.remove();
  });

  it("clears the pending owners-refresh timer on unmount so it cannot fire afterwards", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ refreshSessionOwners: refresh });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(Harness));
    });
    await act(async () => {
      resolveTransferReg?.();
      resolveOwnershipReg?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Drain the on-mount seed refresh and any debounce pending from earlier work.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    refresh.mockClear();

    // Schedule a coalesced refresh, then unmount before the debounce window
    // (150ms) elapses — the timer is still pending at teardown.
    act(() => {
      emitOwnership!();
    });
    await act(async () => {
      root.unmount();
    });

    // Let well over the debounce window pass. The pending refresh must NOT fire
    // after the hook has unmounted.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });

    expect(refresh).not.toHaveBeenCalled();

    container.remove();
  });
});

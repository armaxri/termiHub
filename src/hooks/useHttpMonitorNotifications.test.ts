import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("@/services/networkApi", () => ({
  onHttpMonitorCheck: vi.fn(),
}));

vi.mock("@/components/ui", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { onHttpMonitorCheck } from "@/services/networkApi";
import { toast } from "@/components/ui";
import type { HttpCheckResult } from "@/types/network";
import { useHttpMonitorNotifications } from "./useHttpMonitorNotifications";

const mockOnCheck = vi.mocked(onHttpMonitorCheck);
const mockToast = vi.mocked(toast);

function HookConsumer() {
  useHttpMonitorNotifications();
  return null;
}

function makeResult(overrides: Partial<HttpCheckResult> = {}): HttpCheckResult {
  return {
    monitorId: "mon-1",
    statusCode: 200,
    latencyMs: 12,
    ok: true,
    timestampMs: Date.now(),
    ...overrides,
  };
}

describe("useHttpMonitorNotifications", () => {
  let container: HTMLDivElement;
  let root: Root;
  let checkHandler: ((result: HttpCheckResult) => void) | undefined;
  const unlisten = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockOnCheck.mockImplementation((cb) => {
      checkHandler = cb;
      return Promise.resolve(unlisten);
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mount() {
    await act(async () => {
      root.render(createElement(HookConsumer));
    });
  }

  function emit(result: HttpCheckResult) {
    act(() => {
      checkHandler?.(result);
    });
  }

  it("registers the check listener on mount", async () => {
    await mount();
    expect(mockOnCheck).toHaveBeenCalledTimes(1);
  });

  it("does not toast on the very first result (no previous state to diff)", async () => {
    await mount();
    emit(makeResult({ ok: false, error: "boom" }));
    expect(mockToast.error).not.toHaveBeenCalled();
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("fires a down toast exactly once on an ok -> !ok edge", async () => {
    await mount();
    emit(makeResult({ ok: true }));
    emit(makeResult({ ok: false, error: "500 Internal Server Error" }));

    expect(mockToast.error).toHaveBeenCalledTimes(1);
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("does not re-fire the down toast while steady-state down", async () => {
    await mount();
    emit(makeResult({ ok: true }));
    emit(makeResult({ ok: false, error: "down" }));
    emit(makeResult({ ok: false, error: "down" }));
    emit(makeResult({ ok: false, error: "down" }));

    expect(mockToast.error).toHaveBeenCalledTimes(1);
  });

  it("fires a recovery toast exactly once on a !ok -> ok edge", async () => {
    await mount();
    emit(makeResult({ ok: true }));
    emit(makeResult({ ok: false, error: "down" }));
    mockToast.success.mockClear();
    emit(makeResult({ ok: true, statusCode: 200 }));

    expect(mockToast.success).toHaveBeenCalledTimes(1);
  });

  it("does not re-fire on steady-state up", async () => {
    await mount();
    emit(makeResult({ ok: true }));
    emit(makeResult({ ok: true }));
    emit(makeResult({ ok: true }));

    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("tracks previous ok independently per monitor id", async () => {
    await mount();
    // mon-1 establishes up, then goes down.
    emit(makeResult({ monitorId: "mon-1", ok: true }));
    // mon-2 establishes down as its first result (no toast), then recovers.
    emit(makeResult({ monitorId: "mon-2", ok: false, error: "down" }));
    expect(mockToast.error).not.toHaveBeenCalled();

    emit(makeResult({ monitorId: "mon-1", ok: false, error: "down" }));
    expect(mockToast.error).toHaveBeenCalledTimes(1);

    emit(makeResult({ monitorId: "mon-2", ok: true }));
    expect(mockToast.success).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes the listener on unmount", async () => {
    await mount();
    act(() => root.unmount());
    root = createRoot(container);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

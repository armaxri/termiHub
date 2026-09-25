/**
 * `reclaimSession` (SM-003, single-attach): the one user action that leaves the
 * sticky `evicted` state. It performs the explicit takeover via the
 * `reclaim_session` command; a failure keeps the tab evicted, surfaces an error
 * toast and never retries on its own.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockReclaimSession, toastMocks } = vi.hoisted(() => ({
  mockReclaimSession: vi.fn(),
  toastMocks: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
    promise: vi.fn(),
  },
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return { ...actual, reclaimSession: mockReclaimSession };
});

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, toast: toastMocks };
});

import { useAppStore } from "./appStore";

describe("appStore.reclaimSession (SM-003)", () => {
  beforeEach(() => {
    mockReclaimSession.mockReset();
    toastMocks.error.mockReset();
  });

  it("performs the explicit takeover for the tab and reports success", async () => {
    mockReclaimSession.mockResolvedValue(undefined);

    await expect(useAppStore.getState().reclaimSession("tab-1")).resolves.toBe(true);

    expect(mockReclaimSession).toHaveBeenCalledTimes(1);
    expect(mockReclaimSession).toHaveBeenCalledWith("tab-1");
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it("surfaces a failure once and does not retry on its own", async () => {
    mockReclaimSession.mockRejectedValue(new Error("Session not found"));

    await expect(useAppStore.getState().reclaimSession("tab-1")).resolves.toBe(false);

    expect(mockReclaimSession).toHaveBeenCalledTimes(1);
    expect(toastMocks.error).toHaveBeenCalledTimes(1);
    expect(String(toastMocks.error.mock.calls[0][0])).toContain("Session not found");
  });
});

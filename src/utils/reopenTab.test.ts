/**
 * The coalesced "Closed … / Reopen" toast (#5828): closing several tabs in a
 * row shows one toast that is replaced in place, names a single tab, counts
 * several, and whose Reopen restores every closed tab in order.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ReopenTabPayload } from "@/types/terminal";

interface ShownToast {
  message: string;
  opts: {
    id: string;
    description?: string;
    duration?: number;
    testId?: string;
    dismissOnModal?: boolean;
    action: { label: string; onClick: () => void; testId?: string };
  };
}

/** A toast host that shows one toast per id, like sonner: a reused id replaces it. */
const shown = new Map<string, ShownToast>();
const success = vi.fn((message: string, opts: ShownToast["opts"]) => {
  shown.set(opts.id, { message, opts });
  return opts.id;
});

vi.mock("@/components/ui", () => ({
  toast: {
    success: (message: string, opts: ShownToast["opts"]) => success(message, opts),
    isActive: (id: string) => shown.has(id),
  },
}));

const addTab = vi.fn();
vi.mock("@/store/appStore", () => ({
  useAppStore: { getState: () => ({ addTab }) },
}));

import {
  REOPEN_COALESCE_MS,
  REOPEN_TOAST_ID,
  reopenPayloadForTab,
  reopenToastDescription,
  reopenToastMessage,
  resetReopenToastBatch,
  showReopenToast,
} from "./reopenTab";

function payload(title: string): ReopenTabPayload {
  return { title, connectionType: "local", config: { type: "local", config: { title } } as never };
}

/** The one toast on screen (fails when there is not exactly one). */
function theToast(): ShownToast {
  expect(shown.size).toBe(1);
  return [...shown.values()][0];
}

/** Press the toast's action; like sonner, that also closes it. */
function pressReopen(): void {
  const t = theToast();
  shown.delete(t.opts.id);
  t.opts.action.onClick();
}

describe("showReopenToast (#5828)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T10:00:00Z"));
    shown.clear();
    success.mockClear();
    addTab.mockClear();
    resetReopenToastBatch();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing without a reopenable payload", () => {
    showReopenToast(null);
    expect(success).not.toHaveBeenCalled();
  });

  it("names a single closed tab and reopens it", () => {
    showReopenToast(payload("web-1"));
    const t = theToast();
    expect(t.message).toBe("Closed “web-1”");
    expect(t.opts.description).toBeUndefined();
    expect(t.opts.action.label).toBe("Reopen");
    expect(t.opts.dismissOnModal).toBe(true);
    expect(t.opts.duration).toBe(REOPEN_COALESCE_MS);

    pressReopen();
    expect(addTab).toHaveBeenCalledTimes(1);
    expect(addTab).toHaveBeenCalledWith("web-1", "local", expect.anything(), {
      contentType: "terminal",
    });
  });

  it("three closes in a row leave ONE toast, replaced in place", () => {
    showReopenToast(payload("Terminal"));
    vi.advanceTimersByTime(500);
    showReopenToast(payload("Terminal"));
    vi.advanceTimersByTime(500);
    showReopenToast(payload("build-server"));

    expect(success).toHaveBeenCalledTimes(3);
    for (const call of success.mock.calls) expect(call[1].id).toBe(REOPEN_TOAST_ID);
    const t = theToast();
    expect(t.message).toBe("Closed 3 tabs");
    expect(t.opts.description).toBe("Terminal, Terminal, build-server");
    expect(t.opts.action.label).toBe("Reopen all");
  });

  it("Reopen all restores every closed tab, in the order they were closed", () => {
    showReopenToast(payload("a"));
    showReopenToast(payload("b"));
    showReopenToast(payload("c"));
    pressReopen();
    expect(addTab.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);
  });

  it("after Reopen, the next close starts a fresh single-tab toast", () => {
    showReopenToast(payload("a"));
    showReopenToast(payload("b"));
    pressReopen();
    addTab.mockClear();

    showReopenToast(payload("c"));
    expect(theToast().message).toBe("Closed “c”");
    pressReopen();
    expect(addTab.mock.calls.map((c) => c[0])).toEqual(["c"]);
  });

  it("a close after the window starts a fresh toast instead of joining", () => {
    showReopenToast(payload("a"));
    vi.advanceTimersByTime(REOPEN_COALESCE_MS + 1);
    showReopenToast(payload("b"));
    expect(theToast().message).toBe("Closed “b”");
  });

  it("a close after the toast went away (a dialog, its close button) starts afresh", () => {
    showReopenToast(payload("a"));
    shown.clear(); // e.g. dismissed when a dialog opened (#5665)
    showReopenToast(payload("b"));
    expect(theToast().message).toBe("Closed “b”");
  });

  it("each close within the window extends it", () => {
    showReopenToast(payload("a"));
    vi.advanceTimersByTime(REOPEN_COALESCE_MS - 100);
    showReopenToast(payload("b"));
    vi.advanceTimersByTime(REOPEN_COALESCE_MS - 100);
    showReopenToast(payload("c"));
    expect(theToast().message).toBe("Closed 3 tabs");
  });
});

describe("reopen toast copy", () => {
  it("lists at most three titles, then a count of the rest", () => {
    const closed = ["a", "b", "c", "d", "e"].map(payload);
    expect(reopenToastMessage(closed)).toBe("Closed 5 tabs");
    expect(reopenToastDescription(closed)).toBe("a, b, c and 2 more");
    expect(reopenToastDescription([payload("a")])).toBeUndefined();
  });
});

describe("reopenPayloadForTab", () => {
  it("offers reopen only for plain terminal tabs", () => {
    const base = { title: "t", connectionType: "local" as const, config: payload("t").config };
    expect(reopenPayloadForTab({ ...base, contentType: "terminal" })).toMatchObject({ title: "t" });
    expect(reopenPayloadForTab({ ...base, contentType: "settings" })).toBeNull();
    expect(
      reopenPayloadForTab({ ...base, contentType: "terminal", persistentConnectionId: "p" })
    ).toBeNull();
  });
});

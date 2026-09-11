import { describe, it, expect, vi } from "vitest";
import {
  dndId,
  readDndPanelId,
  asPointerEvent,
  readSessionType,
  copyTerminalSelection,
} from "./SplitView";

// FEC-018: the dnd-kit event data and the remote-session config were read with
// unchecked casts, and the quick-action clipboard write was fire-and-forget.
// These cover the hardened guards and the copy-then-clear behavior.

describe("SplitView dnd guards (FEC-018)", () => {
  it("dndId normalizes string | number ids to a string", () => {
    expect(dndId("tab-1")).toBe("tab-1");
    expect(dndId(42)).toBe("42");
  });

  it("readDndPanelId returns the panelId only for a well-shaped object", () => {
    expect(readDndPanelId({ panelId: "panel-1" })).toBe("panel-1");
    expect(readDndPanelId({ panelId: "panel-1", type: "tab" })).toBe("panel-1");
  });

  it("readDndPanelId returns undefined for malformed / unexpected shapes", () => {
    expect(readDndPanelId(undefined)).toBeUndefined();
    expect(readDndPanelId(null)).toBeUndefined();
    expect(readDndPanelId({})).toBeUndefined();
    expect(readDndPanelId({ panelId: 123 })).toBeUndefined();
    expect(readDndPanelId("panel-1")).toBeUndefined();
    expect(readDndPanelId(7)).toBeUndefined();
  });

  it("asPointerEvent narrows a PointerEvent and rejects other input sources", () => {
    const pointer = new PointerEvent("pointerdown", { clientX: 10, clientY: 20 });
    expect(asPointerEvent(pointer)).toBe(pointer);
    // A keyboard/touch sensor's activatorEvent (or anything non-pointer) → null,
    // so callers never read pointer coordinates off it.
    expect(asPointerEvent(new KeyboardEvent("keydown"))).toBeNull();
    expect(asPointerEvent({ clientX: 5, clientY: 5 })).toBeNull();
    expect(asPointerEvent(null)).toBeNull();
    expect(asPointerEvent(undefined)).toBeNull();
  });

  it("readSessionType reads a string sessionType and defaults to '' otherwise", () => {
    expect(readSessionType({ sessionType: "ssh" })).toBe("ssh");
    expect(readSessionType({})).toBe("");
    expect(readSessionType({ sessionType: 5 })).toBe("");
    expect(readSessionType(null)).toBe("");
    expect(readSessionType(undefined)).toBe("");
  });
});

describe("copyTerminalSelection (FEC-018)", () => {
  it("clears the selection only after a successful clipboard write", async () => {
    const clearSelection = vi.fn();
    const reportError = vi.fn();
    const writeClipboard = vi.fn().mockResolvedValue(undefined);

    await copyTerminalSelection("hello", { writeClipboard, clearSelection, reportError });

    expect(writeClipboard).toHaveBeenCalledWith("hello");
    expect(clearSelection).toHaveBeenCalledTimes(1);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("does NOT clear the selection and surfaces an error when the write fails", async () => {
    const clearSelection = vi.fn();
    const reportError = vi.fn();
    const writeClipboard = vi.fn().mockRejectedValue(new Error("clipboard busy"));

    await copyTerminalSelection("hello", { writeClipboard, clearSelection, reportError });

    // The selection is kept (the user did not actually copy), and the failure is
    // reported rather than swallowed as an unhandled rejection.
    expect(clearSelection).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][0]).toContain("clipboard busy");
  });
});

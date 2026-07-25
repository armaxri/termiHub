/**
 * Tests for the "Move to Window" picker construction (#1901).
 *
 * The picker turns the backend's flat window-label list into the ordered,
 * named, current-flagged entries the tab context menu renders.
 */
import { describe, it, expect } from "vitest";
import {
  windowDisplayName,
  buildWindowPickerEntries,
  hasOtherWindows,
  tabCountHint,
} from "./windowPicker";
import type { WindowInfo } from "@/types/window";

const w = (label: string, tabCount?: number | null): WindowInfo => ({ label, tabCount });

describe("windowDisplayName", () => {
  it("names the primary window", () => {
    expect(windowDisplayName("main")).toBe("Main Window");
  });

  it("numbers spawned windows", () => {
    expect(windowDisplayName("win-1")).toBe("Window 1");
    expect(windowDisplayName("win-42")).toBe("Window 42");
  });

  it("falls back to the raw label for unexpected labels", () => {
    expect(windowDisplayName("popout")).toBe("popout");
  });
});

describe("buildWindowPickerEntries", () => {
  it("returns an entry per window with display name, current flag and tab count", () => {
    const entries = buildWindowPickerEntries([w("main", 3), w("win-1", 0)], "main");
    expect(entries).toEqual([
      { label: "main", name: "Main Window", isCurrent: true, tabCount: 3 },
      { label: "win-1", name: "Window 1", isCurrent: false, tabCount: 0 },
    ]);
  });

  it("defaults an unreported tab count to null", () => {
    const entries = buildWindowPickerEntries([w("win-1")], "main");
    expect(entries[0].tabCount).toBeNull();
  });

  it("orders main first, then win-N ascending regardless of input order", () => {
    const entries = buildWindowPickerEntries(
      [w("win-2"), w("win-10"), w("win-1"), w("main")],
      "win-2"
    );
    expect(entries.map((e) => e.label)).toEqual(["main", "win-1", "win-2", "win-10"]);
  });

  it("marks exactly the current window when it is a spawned window", () => {
    const entries = buildWindowPickerEntries([w("main"), w("win-1")], "win-1");
    expect(entries.find((e) => e.label === "win-1")!.isCurrent).toBe(true);
    expect(entries.find((e) => e.label === "main")!.isCurrent).toBe(false);
  });

  it("flags none when the current label is unknown/null", () => {
    const entries = buildWindowPickerEntries([w("main"), w("win-1")], null);
    expect(entries.every((e) => !e.isCurrent)).toBe(true);
  });
});

describe("tabCountHint", () => {
  it("has no hint for an unreported count", () => {
    expect(tabCountHint(null)).toBeNull();
  });

  it("renders zero as 'empty'", () => {
    expect(tabCountHint(0)).toBe("empty");
  });

  it("singularises one tab", () => {
    expect(tabCountHint(1)).toBe("1 tab");
  });

  it("pluralises more than one tab", () => {
    expect(tabCountHint(2)).toBe("2 tabs");
    expect(tabCountHint(42)).toBe("42 tabs");
  });
});

describe("hasOtherWindows", () => {
  it("is false when only the current window is open", () => {
    expect(hasOtherWindows([w("main")], "main")).toBe(false);
  });

  it("is true once another window exists", () => {
    expect(hasOtherWindows([w("main"), w("win-1")], "main")).toBe(true);
  });

  it("is true when the current label is unknown but windows exist", () => {
    expect(hasOtherWindows([w("main")], null)).toBe(true);
  });
});

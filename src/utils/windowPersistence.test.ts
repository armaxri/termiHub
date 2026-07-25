import { describe, it, expect } from "vitest";
import {
  stampWindowId,
  buildWindowsMeta,
  collectWindowIds,
  hasWindowDimension,
  planWindowRestore,
  assembleWindowedGroups,
} from "./windowPersistence";
import { MAIN_WINDOW_LABEL } from "@/types/window";
import type { WorkspaceTabGroupDef } from "@/types/workspace";

/** A minimal leaf group for tests. */
function group(name: string, windowId?: string): WorkspaceTabGroupDef {
  return {
    name,
    layout: { type: "leaf", tabs: [] },
    ...(windowId ? { windowId } : {}),
  };
}

describe("stampWindowId", () => {
  it("omits windowId for the main window (legacy-compatible shape)", () => {
    const stamped = stampWindowId([group("A"), group("B")], MAIN_WINDOW_LABEL);
    expect(stamped.every((g) => g.windowId === undefined)).toBe(true);
    expect("windowId" in stamped[0]).toBe(false);
  });

  it("stamps a secondary window id onto every group", () => {
    const stamped = stampWindowId([group("A"), group("B")], "win-1");
    expect(stamped.map((g) => g.windowId)).toEqual(["win-1", "win-1"]);
  });

  it("overwrites a stale windowId when re-stamping to main", () => {
    const stamped = stampWindowId([group("A", "win-9")], MAIN_WINDOW_LABEL);
    expect("windowId" in stamped[0]).toBe(false);
  });

  it("overwrites a stale windowId when re-stamping to another window", () => {
    const stamped = stampWindowId([group("A", "win-1")], "win-2");
    expect(stamped[0].windowId).toBe("win-2");
  });

  it("does not mutate the input groups", () => {
    const input = [group("A")];
    stampWindowId(input, "win-1");
    expect(input[0].windowId).toBeUndefined();
  });
});

describe("collectWindowIds", () => {
  it("returns just main when every group is unassigned", () => {
    expect(collectWindowIds([group("A"), group("B")])).toEqual([MAIN_WINDOW_LABEL]);
  });

  it("lists main first then secondary windows in first-appearance order", () => {
    const groups = [group("A", "win-2"), group("B"), group("C", "win-1"), group("D", "win-2")];
    expect(collectWindowIds(groups)).toEqual([MAIN_WINDOW_LABEL, "win-2", "win-1"]);
  });

  it("omits main when no group lives in it", () => {
    expect(collectWindowIds([group("A", "win-1"), group("B", "win-1")])).toEqual(["win-1"]);
  });

  it("returns main for an empty group list", () => {
    expect(collectWindowIds([])).toEqual([MAIN_WINDOW_LABEL]);
  });
});

describe("buildWindowsMeta", () => {
  it("is undefined for a single main window (legacy shape)", () => {
    expect(buildWindowsMeta([group("A"), group("B")])).toBeUndefined();
  });

  it("lists every window when the layout spans more than one", () => {
    const meta = buildWindowsMeta([group("A"), group("B", "win-1")]);
    expect(meta).toEqual([{ id: MAIN_WINDOW_LABEL }, { id: "win-1" }]);
  });

  it("preserves an empty window (owns no groups) via extraWindowIds", () => {
    // win-2 holds no tab group but must still round-trip (#1902 empty window).
    const meta = buildWindowsMeta([group("A"), group("B", "win-1")], ["win-2"]);
    expect(meta).toEqual([{ id: MAIN_WINDOW_LABEL }, { id: "win-1" }, { id: "win-2" }]);
  });

  it("ignores an extra id that already owns groups and drops an extra main", () => {
    const meta = buildWindowsMeta([group("A", "win-1")], ["win-1", MAIN_WINDOW_LABEL]);
    expect(meta).toEqual([{ id: "win-1" }]);
  });
});

describe("hasWindowDimension", () => {
  it("is false for a legacy layout", () => {
    expect(hasWindowDimension([group("A"), group("B")])).toBe(false);
  });

  it("is true when a group carries a secondary windowId", () => {
    expect(hasWindowDimension([group("A"), group("B", "win-1")])).toBe(true);
  });

  it("is true when windows[] declares a secondary window even with no assigned group", () => {
    expect(hasWindowDimension([group("A")], [{ id: MAIN_WINDOW_LABEL }, { id: "win-3" }])).toBe(
      true
    );
  });

  it("is false when windows[] holds only main", () => {
    expect(hasWindowDimension([group("A")], [{ id: MAIN_WINDOW_LABEL }])).toBe(false);
  });
});

describe("planWindowRestore", () => {
  it("puts every group into the main window for a legacy layout", () => {
    const plan = planWindowRestore([group("A"), group("B")]);
    expect(plan).toHaveLength(1);
    expect(plan[0].windowId).toBe(MAIN_WINDOW_LABEL);
    expect(plan[0].isMain).toBe(true);
    expect(plan[0].tabGroups.map((g) => g.name)).toEqual(["A", "B"]);
  });

  it("partitions groups by window, main first", () => {
    const groups = [group("A"), group("B", "win-1"), group("C", "win-1"), group("D", "win-2")];
    const plan = planWindowRestore(groups, [
      { id: MAIN_WINDOW_LABEL },
      { id: "win-1" },
      { id: "win-2" },
    ]);
    expect(plan.map((e) => e.windowId)).toEqual([MAIN_WINDOW_LABEL, "win-1", "win-2"]);
    expect(plan[0].tabGroups.map((g) => g.name)).toEqual(["A"]);
    expect(plan[1].tabGroups.map((g) => g.name)).toEqual(["B", "C"]);
    expect(plan[2].tabGroups.map((g) => g.name)).toEqual(["D"]);
    expect(plan.map((e) => e.isMain)).toEqual([true, false, false]);
  });

  it("preserves an empty declared window as an entry with no groups", () => {
    const plan = planWindowRestore(
      [group("A"), group("B", "win-1")],
      [{ id: MAIN_WINDOW_LABEL }, { id: "win-1" }, { id: "win-2" }]
    );
    const empty = plan.find((e) => e.windowId === "win-2");
    expect(empty).toBeDefined();
    expect(empty?.tabGroups).toEqual([]);
  });

  it("honours the declared window order over first-appearance order", () => {
    const groups = [group("A", "win-2"), group("B", "win-1")];
    const plan = planWindowRestore(groups, [
      { id: MAIN_WINDOW_LABEL },
      { id: "win-1" },
      { id: "win-2" },
    ]);
    expect(plan.map((e) => e.windowId)).toEqual([MAIN_WINDOW_LABEL, "win-1", "win-2"]);
  });

  it("falls back to first-appearance order for windows not declared", () => {
    const groups = [group("A", "win-2"), group("B", "win-1")];
    const plan = planWindowRestore(groups);
    // main is always synthesised first even when it owns no groups.
    expect(plan.map((e) => e.windowId)).toEqual([MAIN_WINDOW_LABEL, "win-2", "win-1"]);
    expect(plan[0].tabGroups).toEqual([]);
  });

  it("round-trips a stamped capture back into the same partition", () => {
    const captured = [
      ...stampWindowId([group("A"), group("B")], MAIN_WINDOW_LABEL),
      ...stampWindowId([group("C")], "win-1"),
    ];
    const windows = buildWindowsMeta(captured);
    const plan = planWindowRestore(captured, windows);
    expect(plan.map((e) => e.windowId)).toEqual([MAIN_WINDOW_LABEL, "win-1"]);
    expect(plan[0].tabGroups.map((g) => g.name)).toEqual(["A", "B"]);
    expect(plan[1].tabGroups.map((g) => g.name)).toEqual(["C"]);
  });
});

describe("assembleWindowedGroups (#1925)", () => {
  it("produces the legacy shape for a single main window", () => {
    const result = assembleWindowedGroups([
      { windowId: MAIN_WINDOW_LABEL, tabGroups: [group("A"), group("B")] },
    ]);
    expect(result.windows).toBeUndefined();
    expect(result.tabGroups.every((g) => g.windowId === undefined)).toBe(true);
  });

  it("stamps each window's groups and records windows[] main-first", () => {
    const result = assembleWindowedGroups([
      { windowId: MAIN_WINDOW_LABEL, tabGroups: [group("A")] },
      { windowId: "win-1", tabGroups: [group("B")] },
    ]);
    expect(result.windows).toEqual([{ id: MAIN_WINDOW_LABEL }, { id: "win-1" }]);
    expect(result.tabGroups.map((g) => g.windowId)).toEqual([undefined, "win-1"]);
    // Round-trips: assembling then planning recovers the per-window partition.
    const plan = planWindowRestore(result.tabGroups, result.windows);
    expect(plan.map((e) => e.windowId)).toEqual([MAIN_WINDOW_LABEL, "win-1"]);
    expect(plan[1].tabGroups.map((g) => g.name)).toEqual(["B"]);
  });

  it("records a secondary window that owns no groups as an empty window", () => {
    const result = assembleWindowedGroups([
      { windowId: MAIN_WINDOW_LABEL, tabGroups: [group("A")] },
      { windowId: "win-1", tabGroups: [] },
    ]);
    // win-1 carries no group, so it survives only via the explicit windows[] entry.
    expect(result.windows).toEqual([{ id: MAIN_WINDOW_LABEL }, { id: "win-1" }]);
    expect(result.tabGroups.map((g) => g.name)).toEqual(["A"]);
    const plan = planWindowRestore(result.tabGroups, result.windows);
    expect(plan.find((e) => e.windowId === "win-1")?.tabGroups).toEqual([]);
  });
});

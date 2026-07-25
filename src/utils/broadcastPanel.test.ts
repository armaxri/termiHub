import { describe, it, expect } from "vitest";
import { broadcastPanelClass } from "./broadcastPanel";

/**
 * Unit tests for the broadcast panel-ring helper (#1957).
 *
 * Pins the source-vs-target-vs-none decision the SplitView panel wrapper uses to
 * ring participating panels, driven off the broadcast store state (#1955).
 */
describe("broadcastPanelClass (#1957)", () => {
  const inactive = {
    broadcastActive: false,
    broadcastSourceTabId: null,
    broadcastTargetTabIds: new Set<string>(),
  };

  it("returns '' when broadcast is inactive", () => {
    expect(broadcastPanelClass("src", inactive)).toBe("");
  });

  it("returns '' for a null active tab (empty panel)", () => {
    expect(
      broadcastPanelClass(null, {
        broadcastActive: true,
        broadcastSourceTabId: "src",
        broadcastTargetTabIds: new Set(["src"]),
      })
    ).toBe("");
  });

  it("rings the source panel with the source class (ring + glow)", () => {
    expect(
      broadcastPanelClass("src", {
        broadcastActive: true,
        broadcastSourceTabId: "src",
        broadcastTargetTabIds: new Set(["src", "t2"]),
      })
    ).toBe("panel--broadcast-source");
  });

  it("rings a non-source target panel with the target class (ring only)", () => {
    expect(
      broadcastPanelClass("t2", {
        broadcastActive: true,
        broadcastSourceTabId: "src",
        broadcastTargetTabIds: new Set(["src", "t2"]),
      })
    ).toBe("panel--broadcast-target");
  });

  it("returns '' for a panel whose active tab is not participating", () => {
    expect(
      broadcastPanelClass("other", {
        broadcastActive: true,
        broadcastSourceTabId: "src",
        broadcastTargetTabIds: new Set(["src", "t2"]),
      })
    ).toBe("");
  });

  it("prefers the source class when the source is (as always) also in the target set", () => {
    // The foundation includes the source in broadcastTargetTabIds; the source
    // panel must still glow rather than fall through to the target class.
    expect(
      broadcastPanelClass("src", {
        broadcastActive: true,
        broadcastSourceTabId: "src",
        broadcastTargetTabIds: new Set(["src"]),
      })
    ).toBe("panel--broadcast-source");
  });
});

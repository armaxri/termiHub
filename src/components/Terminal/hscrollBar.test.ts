import { describe, it, expect } from "vitest";
import {
  createHscrollProbe,
  HSCROLL_PROBE_CLASS,
  measureHscrollBar,
  syncHscrollBar,
} from "./hscrollBar";

/** A probe whose laid-out box reports `offset` and `client` heights. */
function probeWith(offset: number, client: number): HTMLDivElement {
  const probe = createHscrollProbe();
  Object.defineProperty(probe, "offsetHeight", { configurable: true, value: offset });
  Object.defineProperty(probe, "clientHeight", { configurable: true, value: client });
  return probe;
}

describe("hscrollBar (#5280)", () => {
  it("creates a hidden probe with the probe class", () => {
    const probe = createHscrollProbe();
    expect(probe.classList.contains(HSCROLL_PROBE_CLASS)).toBe(true);
    expect(probe.getAttribute("aria-hidden")).toBe("true");
  });

  it("measures a classic bar as offsetHeight - clientHeight", () => {
    expect(measureHscrollBar(probeWith(40, 27))).toBe(13);
    expect(measureHscrollBar(probeWith(40, 30))).toBe(10);
  });

  it("reports no bar for overlay scrollbars and implausible readings", () => {
    expect(measureHscrollBar(probeWith(40, 40))).toBeNull(); // overlay: no layout space
    expect(measureHscrollBar(probeWith(0, 0))).toBeNull(); // never laid out
    expect(measureHscrollBar(probeWith(504, 0))).toBeNull(); // not a scrollbar
  });

  it("sets --hscroll-bar to the measured bar and reports the change once", () => {
    const container = document.createElement("div");
    expect(syncHscrollBar(container, probeWith(40, 27))).toBe(true);
    expect(container.style.getPropertyValue("--hscroll-bar")).toBe("13px");
    expect(syncHscrollBar(container, probeWith(40, 27))).toBe(false);
  });

  it("falls back to the CSS default when the bar takes no layout space", () => {
    const container = document.createElement("div");
    syncHscrollBar(container, probeWith(40, 27));
    expect(syncHscrollBar(container, probeWith(40, 40))).toBe(true);
    expect(container.style.getPropertyValue("--hscroll-bar")).toBe("");
    expect(syncHscrollBar(container, probeWith(40, 40))).toBe(false);
  });
});

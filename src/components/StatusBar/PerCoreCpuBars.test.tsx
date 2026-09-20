/**
 * Tests for the per-core CPU mini-bars in the monitoring dropdown (#3178).
 *
 * The component renders one bar per core (height = usage, colour = severity) and
 * renders nothing when no per-core data is available (non-Linux SSH remote or an
 * older agent), so hosts without the metric are unaffected.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { PerCoreCpuBars } from "./PerCoreCpuBars";

describe("PerCoreCpuBars (#3178)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(values: number[]) {
    act(() => root.render(React.createElement(PerCoreCpuBars, { values })));
  }

  it("renders nothing when there is no per-core data", () => {
    render([]);
    expect(container.querySelector('[data-testid="monitoring-per-core"]')).toBeNull();
  });

  it("renders one bar per core with the core count", () => {
    render([10, 55, 95, 0]);
    const block = container.querySelector('[data-testid="monitoring-per-core"]');
    expect(block).not.toBeNull();
    expect(block!.textContent).toContain("4");
    expect(container.querySelectorAll('[data-testid^="monitoring-core-"]').length).toBe(4);
  });

  it("encodes usage as the fill height and clamps out-of-range values", () => {
    render([25, 150, -5]);
    const fills = container.querySelectorAll<HTMLElement>(".monitoring-menu__core-fill");
    expect(fills[0].style.height).toBe("25%");
    // Values above 100 / below 0 are clamped into range.
    expect(fills[1].style.height).toBe("100%");
    expect(fills[2].style.height).toBe("0%");
  });

  it("colours each bar by its severity band", () => {
    render([10, 75, 95]);
    const fills = container.querySelectorAll<HTMLElement>(".monitoring-menu__core-fill");
    expect(fills[0].className).toContain("monitoring-menu__core-fill--normal");
    expect(fills[1].className).toContain("monitoring-menu__core-fill--warning");
    expect(fills[2].className).toContain("monitoring-menu__core-fill--critical");
  });

  it("labels each core with its index and rounded percentage", () => {
    render([42.6]);
    const core = container.querySelector('[data-testid="monitoring-core-0"]');
    expect(core!.getAttribute("title")).toBe("Core 0: 43%");
  });
});

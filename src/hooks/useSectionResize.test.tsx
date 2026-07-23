/**
 * Regression tests for {@link useSectionResize}.
 *
 * The hook feeds per-section `flex` values straight into inline styles. If the
 * returned array is ever shorter than `expandedCount` — which happens for the
 * render right after the number of sections grows, before the internal reset
 * effect runs — a section reads `flexValues[i] === undefined` and renders with
 * `flex: undefined` (i.e. `flex: 0 1 auto`, size-to-content) instead of
 * flex-filling its slot. That produces a clipped/mis-laid-out sidebar on first
 * paint that only corrects after a manual resize forces a reflow (#1828).
 *
 * These tests assert the hook never returns a short or hole-containing array on
 * ANY render, including the transient one where `expandedCount` just grew.
 */
import { describe, it, expect, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useSectionResize } from "./useSectionResize";

interface Capture {
  expandedCount: number;
  flexValues: number[];
}

let container: HTMLDivElement;
let root: Root;

function Harness({ expandedCount, log }: { expandedCount: number; log: Capture[] }) {
  const { flexValues } = useSectionResize(expandedCount);
  // Record what this render would hand to the section inline styles.
  log.push({ expandedCount, flexValues });
  return null;
}

afterEach(() => {
  if (root) act(() => root.unmount());
  if (container) container.remove();
});

function renderHarness(expandedCount: number, log: Capture[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(Harness, { expandedCount, log }));
  });
}

describe("useSectionResize", () => {
  it("returns one flex value per expanded section on the initial render", () => {
    const log: Capture[] = [];
    renderHarness(3, log);

    const first = log[0];
    expect(first.flexValues).toHaveLength(3);
    expect(first.flexValues.every((v) => typeof v === "number" && Number.isFinite(v))).toBe(true);
  });

  it("never yields a hole or short array on the render where the count grows", () => {
    // Start collapsed/empty (as when settings + remote agents are still loading),
    // then grow — the async path that produced the first-paint glitch.
    const log: Capture[] = [];
    renderHarness(0, log);

    act(() => {
      root.render(React.createElement(Harness, { expandedCount: 4, log }));
    });

    // Every captured render — including the transient one right after the count
    // grew, before any effect runs — must expose a full, hole-free flex array.
    for (const { expandedCount, flexValues } of log) {
      expect(flexValues).toHaveLength(expandedCount);
      for (let i = 0; i < expandedCount; i++) {
        expect(flexValues[i]).toBeTypeOf("number");
        expect(Number.isFinite(flexValues[i])).toBe(true);
      }
    }
  });

  it("stays hole-free when growing from a non-zero count", () => {
    const log: Capture[] = [];
    renderHarness(1, log);

    act(() => {
      root.render(React.createElement(Harness, { expandedCount: 3, log }));
    });

    for (const { expandedCount, flexValues } of log) {
      expect(flexValues).toHaveLength(expandedCount);
      expect(flexValues.slice(0, expandedCount).some((v) => v === undefined)).toBe(false);
    }
  });
});

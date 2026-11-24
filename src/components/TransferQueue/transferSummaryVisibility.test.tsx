import { describe, it, expect, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  isTransferSummaryShown,
  resetTransferSummaries,
  showTransferSummary,
  useTransferSummariesVersion,
} from "./transferSummaryVisibility";

describe("transferSummaryVisibility (#5859)", () => {
  beforeEach(() => resetTransferSummaries());

  it("reports a session's summary while it is shown", () => {
    expect(isTransferSummaryShown("s1")).toBe(false);
    const hide = showTransferSummary("s1");
    expect(isTransferSummaryShown("s1")).toBe(true);
    expect(isTransferSummaryShown("s2")).toBe(false);
    hide();
    expect(isTransferSummaryShown("s1")).toBe(false);
  });

  it("keeps a session shown until the last overlapping summary goes", () => {
    const first = showTransferSummary("s1");
    const second = showTransferSummary("s1");
    first();
    expect(isTransferSummaryShown("s1")).toBe(true);
    second();
    expect(isTransferSummaryShown("s1")).toBe(false);
  });

  it("ignores a repeated hide", () => {
    const first = showTransferSummary("s1");
    const second = showTransferSummary("s1");
    first();
    first();
    expect(isTransferSummaryShown("s1")).toBe(true);
    second();
    expect(isTransferSummaryShown("s1")).toBe(false);
  });

  it("re-renders a subscriber when a summary appears or goes away, not on overlap (#5834)", () => {
    let renders = 0;
    function Probe() {
      useTransferSummariesVersion();
      renders += 1;
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(<Probe />));
    const base = renders;

    let first: () => void = () => {};
    let second: () => void = () => {};
    act(() => {
      first = showTransferSummary("s1");
    });
    expect(renders).toBe(base + 1);
    act(() => {
      second = showTransferSummary("s1");
    });
    act(() => first());
    expect(renders).toBe(base + 1);
    act(() => second());
    expect(renders).toBe(base + 2);
    act(() => root.unmount());
  });
});

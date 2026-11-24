import { describe, it, expect, beforeEach } from "vitest";
import {
  isTransferSummaryShown,
  resetTransferSummaries,
  showTransferSummary,
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
});

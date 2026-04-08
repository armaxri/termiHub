/**
 * Regression test for box-drawing character gaps caused by lineHeight > 1.0.
 *
 * Box-drawing characters (─ │ ┌ ┐ └ ┘ ├ ┤ etc.) are designed to connect at
 * the exact top/bottom pixel edges of a terminal cell. A lineHeight above 1.0
 * adds extra vertical padding between rows, creating visible gaps that break
 * table borders. This test ensures the default stays at 1.0.
 *
 * Manual verification: run the following in a termiHub terminal and confirm
 * all borders are solid and connected:
 *
 *   printf '┌──────┐\n│ test │\n└──────┘\n'
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_LINE_HEIGHT } from "./Terminal";

describe("Terminal line height default", () => {
  it("defaults to 1.0 so box-drawing characters connect without gaps", () => {
    expect(DEFAULT_LINE_HEIGHT).toBe(1.0);
  });

  it("is a number in the valid xterm.js lineHeight range (0.8–2.0)", () => {
    expect(DEFAULT_LINE_HEIGHT).toBeGreaterThanOrEqual(0.8);
    expect(DEFAULT_LINE_HEIGHT).toBeLessThanOrEqual(2.0);
  });
});

import { describe, it, expect } from "vitest";
import { formatMacroStepData, summariseMacroSteps } from "./macroStepFormat";

describe("formatMacroStepData", () => {
  it("passes printable characters through unchanged", () => {
    expect(formatMacroStepData("ls -la")).toBe("ls -la");
  });

  it("renders Enter, Tab and ESC as friendly glyphs", () => {
    expect(formatMacroStepData("ls\r")).toBe("ls⏎");
    expect(formatMacroStepData("\t")).toBe("⇥");
    expect(formatMacroStepData("\x1b")).toBe("⎋");
  });

  it("uses caret notation for other control characters", () => {
    // Ctrl-C is 0x03 → "^C".
    expect(formatMacroStepData("\x03")).toBe("^C");
    // Backspace (0x7f) → "⌫" (a named control), not caret.
    expect(formatMacroStepData("\x7f")).toBe("⌫");
  });

  it("truncates long input with an ellipsis", () => {
    const long = "a".repeat(200);
    const out = formatMacroStepData(long, 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("summariseMacroSteps", () => {
  it("joins step data into one readable preview", () => {
    expect(
      summariseMacroSteps([
        { data: "echo hi", delayMs: 0 },
        { data: "\r", delayMs: 5 },
      ])
    ).toBe("echo hi⏎");
  });

  it("returns an empty string for no steps", () => {
    expect(summariseMacroSteps([])).toBe("");
  });
});

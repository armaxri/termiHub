import { describe, it, expect } from "vitest";
import {
  escapeMacroStepData,
  formatMacroStepData,
  parseMacroStepText,
  summariseMacroSteps,
} from "./macroStepFormat";

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

describe("escapeMacroStepData", () => {
  it("leaves printable text unchanged", () => {
    expect(escapeMacroStepData("ls -la | grep x")).toBe("ls -la | grep x");
    expect(escapeMacroStepData("héllo ✓")).toBe("héllo ✓");
  });

  it("uses short escapes for Enter, LF, Tab, Esc and backslash", () => {
    expect(escapeMacroStepData("ls\r")).toBe("ls\\r");
    expect(escapeMacroStepData("a\nb\tc")).toBe("a\\nb\\tc");
    expect(escapeMacroStepData("\x1b[A")).toBe("\\e[A");
    expect(escapeMacroStepData("C:\\dir")).toBe("C:\\\\dir");
  });

  it("uses \\xHH for every other control character, so no raw control chars remain", () => {
    expect(escapeMacroStepData("\x03")).toBe("\\x03");
    expect(escapeMacroStepData("\x7f")).toBe("\\x7f");
    expect(escapeMacroStepData("\x00")).toBe("\\x00");
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x1f\x7f]/.test(escapeMacroStepData("\x01\x02\x1b\r\n\x7f"))).toBe(false);
  });
});

describe("parseMacroStepText", () => {
  it("decodes each escape into the raw input", () => {
    expect(parseMacroStepText("ls -la\\r")).toEqual({ ok: true, data: "ls -la\r" });
    expect(parseMacroStepText("\\e[A\\t\\n")).toEqual({ ok: true, data: "\x1b[A\t\n" });
    expect(parseMacroStepText("\\x03\\x7F")).toEqual({ ok: true, data: "\x03\x7f" });
    expect(parseMacroStepText("a\\\\b")).toEqual({ ok: true, data: "a\\b" });
  });

  it("rejects an unknown escape", () => {
    const r = parseMacroStepText("echo \\q");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("\\q");
  });

  it("rejects a malformed hex escape", () => {
    expect(parseMacroStepText("\\x4").ok).toBe(false);
    expect(parseMacroStepText("\\xZZ").ok).toBe(false);
  });

  it("rejects a trailing backslash", () => {
    expect(parseMacroStepText("abc\\").ok).toBe(false);
  });

  it("is the exact inverse of escapeMacroStepData for every recorded input", () => {
    const samples = [
      "",
      "ls\r",
      "\x1b[1;5A",
      "C:\\Users\\me\r\n",
      "literal \\r text",
      "\\x41",
      "héllo ✓ 😀",
      "\x7f\x7f\x03\x04",
    ];
    // Plus every single code unit 0x00–0xff.
    for (let c = 0; c <= 0xff; c++) samples.push(String.fromCharCode(c));
    for (const data of samples) {
      expect(parseMacroStepText(escapeMacroStepData(data))).toEqual({ ok: true, data });
    }
  });
});

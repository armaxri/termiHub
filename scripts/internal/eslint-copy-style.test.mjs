import { describe, it, expect } from "vitest";
import {
  britishSpelling,
  formatMessage,
  parseMessage,
  titleCaseWords,
} from "./eslint-copy-style.mjs";
import { pruneBaseline, toBaseline } from "./copy-style-baseline.mjs";

describe("titleCaseWords", () => {
  it("flags capitalized words after the first word", () => {
    expect(titleCaseWords("Save & Connect")).toEqual(["Connect"]);
    expect(titleCaseWords("Clear History")).toEqual(["History"]);
    expect(titleCaseWords("Read-Only Mode")).toEqual(["Only", "Mode"]);
  });

  it("allows sentence case, acronyms, mixed-case names and proper nouns", () => {
    expect(titleCaseWords("Allow experimental features")).toEqual([]);
    expect(titleCaseWords("Open SSH session in termiHub")).toEqual([]);
    expect(titleCaseWords("Use PowerShell on Windows or macOS")).toEqual([]);
    expect(titleCaseWords("Press Ctrl and Shift")).toEqual([]);
  });

  it("restarts at a new sentence and skips quoted names", () => {
    expect(titleCaseWords("Saved. Reconnect to apply")).toEqual([]);
    expect(titleCaseWords("Error: Something failed")).toEqual([]);
    expect(titleCaseWords('Delete "My Server"')).toEqual([]);
  });
});

describe("britishSpelling", () => {
  it("finds British spellings and names the US form", () => {
    expect(britishSpelling("Transfer cancelled")?.us).toBe("canceled / canceling");
    expect(britishSpelling("Pick a colour")?.us).toBe("color");
    expect(britishSpelling("Initialise the store")?.us).toBe("-ize / -ization");
  });

  it("leaves US spelling and look-alikes alone", () => {
    expect(britishSpelling("Transfer canceled")).toBeNull();
    expect(britishSpelling("Pick a color")).toBeNull();
    expect(britishSpelling("Cancellation pending")).toBeNull();
    expect(britishSpelling("Raise the window, otherwise wise")).toBeNull();
  });
});

describe("message format", () => {
  it("round-trips the check and text, including quotes and dashes", () => {
    const text = 'Saved "a" — b';
    expect(parseMessage(formatMessage("sentence-case", text))).toEqual({
      check: "sentence-case",
      text,
    });
    expect(parseMessage("some other message")).toBeNull();
  });
});

describe("baseline tool", () => {
  it("counts violations per file, check and text", () => {
    expect(
      toBaseline([
        { file: "b.tsx", check: "discard", text: "Just close" },
        { file: "a.tsx", check: "sentence-case", text: "Save Now" },
        { file: "a.tsx", check: "sentence-case", text: "Save Now" },
      ])
    ).toEqual({
      "a.tsx": { "sentence-case": { "Save Now": 2 } },
      "b.tsx": { discard: { "Just close": 1 } },
    });
  });

  it("prunes fixed entries and never adds new ones", () => {
    const baseline = {
      "a.tsx": { "sentence-case": { "Save Now": 2, "Clear History": 1 } },
      "b.tsx": { discard: { "Just close": 1 } },
    };
    const current = {
      "a.tsx": { "sentence-case": { "Save Now": 1, "New Thing": 1 } },
      "b.tsx": { discard: { "Just close": 1 } },
    };
    const { pruned, stale } = pruneBaseline(baseline, current);
    expect(pruned).toEqual({
      "a.tsx": { "sentence-case": { "Save Now": 1 } },
      "b.tsx": { discard: { "Just close": 1 } },
    });
    expect(stale).toEqual([
      { file: "a.tsx", check: "sentence-case", text: "Save Now", count: 1 },
      { file: "a.tsx", check: "sentence-case", text: "Clear History", count: 1 },
    ]);
  });
});

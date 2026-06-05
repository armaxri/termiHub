import { describe, it, expect } from "vitest";
import {
  DEFAULT_LINE_ENDING,
  lineEndingSequence,
  normalizeLineEndings,
  resolveLineEnding,
} from "./lineEndings";

describe("lineEndingSequence", () => {
  it("maps each mode to its byte sequence", () => {
    expect(lineEndingSequence("cr")).toBe("\r");
    expect(lineEndingSequence("lf")).toBe("\n");
    expect(lineEndingSequence("crlf")).toBe("\r\n");
  });
});

describe("normalizeLineEndings", () => {
  it("converts Windows CRLF to a single LF (fixes the double-line paste bug)", () => {
    expect(normalizeLineEndings("a\r\nb\r\nc", "lf")).toBe("a\nb\nc");
  });

  it("converts lone LF to CRLF", () => {
    expect(normalizeLineEndings("a\nb\nc", "crlf")).toBe("a\r\nb\r\nc");
  });

  it("converts lone CR to LF", () => {
    expect(normalizeLineEndings("a\rb\rc", "lf")).toBe("a\nb\nc");
  });

  it("converts a bare Enter keystroke (CR) to the target ending", () => {
    expect(normalizeLineEndings("\r", "lf")).toBe("\n");
    expect(normalizeLineEndings("\r", "crlf")).toBe("\r\n");
    expect(normalizeLineEndings("\r", "cr")).toBe("\r");
  });

  it("handles mixed line endings without producing blank lines", () => {
    // CRLF, lone LF, lone CR all collapse to exactly one target ending each.
    expect(normalizeLineEndings("a\r\nb\nc\rd", "lf")).toBe("a\nb\nc\nd");
    expect(normalizeLineEndings("a\r\nb\nc\rd", "crlf")).toBe("a\r\nb\r\nc\r\nd");
  });

  it("never collapses CRLF into two endings", () => {
    // The bug: \r\n treated as two line breaks → blank line between rows.
    const out = normalizeLineEndings("line1\r\nline2", "lf");
    expect(out).toBe("line1\nline2");
    expect(out.split("\n")).toHaveLength(2);
  });

  it("leaves text without line breaks untouched", () => {
    expect(normalizeLineEndings("plain text", "crlf")).toBe("plain text");
    expect(normalizeLineEndings("", "lf")).toBe("");
  });

  it("preserves trailing and leading newlines as a single ending each", () => {
    expect(normalizeLineEndings("\r\na\r\n", "lf")).toBe("\na\n");
  });
});

describe("resolveLineEnding", () => {
  it("prefers the per-connection override", () => {
    expect(resolveLineEnding("crlf", "lf")).toBe("crlf");
  });

  it("falls back to the global default when no override is set", () => {
    expect(resolveLineEnding(undefined, "cr")).toBe("cr");
  });

  it("falls back to the built-in default (LF) when nothing is configured", () => {
    expect(resolveLineEnding(undefined, undefined)).toBe("lf");
    expect(DEFAULT_LINE_ENDING).toBe("lf");
  });
});

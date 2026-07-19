import { describe, it, expect, vi, afterEach } from "vitest";
import { Terminal } from "@xterm/xterm";
import {
  SyntaxHighlightingEngine,
  compileRules,
  findMatches,
  normalizeHexColor,
} from "./syntaxHighlighting";
import type { HighlightRule } from "../types/syntaxHighlighting";

function rule(
  overrides: Partial<HighlightRule> & Pick<HighlightRule, "id" | "pattern">
): HighlightRule {
  return {
    name: overrides.id,
    style: { color: "#ff0000" },
    enabled: true,
    priority: 0,
    builtin: true,
    ...overrides,
  } as HighlightRule;
}

describe("normalizeHexColor", () => {
  it("passes through #RRGGBB (lowercased)", () => {
    expect(normalizeHexColor("#FF5733")).toBe("#ff5733");
  });
  it("expands #RGB shorthand", () => {
    expect(normalizeHexColor("#abc")).toBe("#aabbcc");
  });
  it("rejects named colors, rgb(), alpha hex and garbage", () => {
    expect(normalizeHexColor("red")).toBeNull();
    expect(normalizeHexColor("rgb(1,2,3)")).toBeNull();
    expect(normalizeHexColor("#ff5733aa")).toBeNull();
    expect(normalizeHexColor("nonsense")).toBeNull();
  });
});

describe("compileRules", () => {
  it("skips disabled rules", () => {
    const compiled = compileRules([rule({ id: "a", pattern: "x", enabled: false })]);
    expect(compiled).toHaveLength(0);
  });

  it("skips rules with an invalid regex without throwing", () => {
    expect(() => compileRules([rule({ id: "bad", pattern: "(" })])).not.toThrow();
    expect(compileRules([rule({ id: "bad", pattern: "(" })])).toHaveLength(0);
  });

  it("skips rules whose color is not #RRGGBB-able", () => {
    const compiled = compileRules([rule({ id: "c", pattern: "x", style: { color: "blue" } })]);
    expect(compiled).toHaveLength(0);
  });

  it("applies wholeWord and case-insensitivity flags", () => {
    const [compiled] = compileRules([
      rule({ id: "w", pattern: "cat", wholeWord: true, caseSensitive: false }),
    ]);
    expect(compiled.regex.flags).toContain("i");
    expect("a CAT sat".match(compiled.regex)?.[0]).toBe("CAT");
    // wholeWord means "category" should NOT match
    compiled.regex.lastIndex = 0;
    expect(compiled.regex.test("category")).toBe(false);
  });
});

describe("findMatches overlap resolution", () => {
  it("longest match wins over a shorter overlapping one", () => {
    const compiled = compileRules([
      rule({ id: "num", pattern: "\\d+", priority: 1 }),
      rule({ id: "ip", pattern: "\\d+\\.\\d+\\.\\d+\\.\\d+", priority: 1 }),
    ]);
    const matches = findMatches("host 192.168.1.1 end", compiled);
    expect(matches).toHaveLength(1);
    expect(matches[0].rule.id).toBe("ip");
    expect(matches[0].start).toBe(5);
    expect(matches[0].end).toBe(16);
  });

  it("higher priority wins on equal length", () => {
    const compiled = compileRules([
      rule({ id: "low", pattern: "FOO", priority: 2 }),
      rule({ id: "high", pattern: "FOO", priority: 0 }),
    ]);
    const matches = findMatches("FOO", compiled);
    expect(matches).toHaveLength(1);
    expect(matches[0].rule.id).toBe("high");
  });

  it("first rule wins on equal length and priority", () => {
    const compiled = compileRules([
      rule({ id: "first", pattern: "FOO", priority: 0 }),
      rule({ id: "second", pattern: "FOO", priority: 0 }),
    ]);
    const matches = findMatches("FOO", compiled);
    expect(matches[0].rule.id).toBe("first");
  });

  it("returns multiple non-overlapping matches left to right", () => {
    const compiled = compileRules([rule({ id: "n", pattern: "\\d+" })]);
    const matches = findMatches("1 and 22 and 333", compiled);
    expect(matches.map((m) => m.end - m.start)).toEqual([1, 2, 3]);
    expect(matches.map((m) => m.start)).toEqual([0, 6, 13]);
  });

  it("does not loop on zero-width patterns", () => {
    const compiled = compileRules([rule({ id: "z", pattern: "a*" })]);
    // Should terminate and produce only the non-empty match.
    const matches = findMatches("xaax", compiled);
    expect(matches).toEqual([expect.objectContaining({ start: 1, end: 3 })]);
  });
});

/** Write data into a headless xterm and wait for parsing to settle. */
async function makeTerm(data: string, cols = 80): Promise<Terminal> {
  const term = new Terminal({ cols, rows: 6, allowProposedApi: true, scrollback: 1000 });
  await new Promise<void>((resolve) => term.write(data, () => resolve()));
  return term;
}

describe("SyntaxHighlightingEngine lifecycle", () => {
  let term: Terminal;

  const errorRule = rule({
    id: "err",
    pattern: "ERROR",
    style: { color: "#f44747" },
    priority: 0,
  });

  afterEach(() => {
    term?.dispose();
  });

  it("creates foreground decorations on default-fg cells after enable", async () => {
    term = await makeTerm("plain ERROR here\r\n");
    const decoSpy = vi.spyOn(term, "registerDecoration");

    const engine = new SyntaxHighlightingEngine(term);
    engine.enable([errorRule]);

    expect(decoSpy).toHaveBeenCalledTimes(1);
    const opts = decoSpy.mock.calls[0][0];
    expect(opts.foregroundColor).toBe("#f44747");
    expect(opts.x).toBe(6); // "plain " is 6 chars
    expect(opts.width).toBe(5); // "ERROR"

    engine.dispose();
  });

  it("skips a match that sits entirely on ANSI-colored cells", async () => {
    // The whole word ERROR is colored red by the server via SGR.
    term = await makeTerm("plain \x1b[31mERROR\x1b[0m tail\r\n");
    const decoSpy = vi.spyOn(term, "registerDecoration");

    const engine = new SyntaxHighlightingEngine(term);
    engine.enable([errorRule]);

    expect(decoSpy).not.toHaveBeenCalled();
    engine.dispose();
  });

  it("splits a match around ANSI-colored cells, decorating only default-fg parts", async () => {
    // "ERROR" where only "RO" (middle) is server-colored -> two runs "ER" and "R".
    term = await makeTerm("ER\x1b[31mRO\x1b[0mR done\r\n");
    const decoSpy = vi.spyOn(term, "registerDecoration");

    const engine = new SyntaxHighlightingEngine(term);
    engine.enable([errorRule]);

    // Two runs: "ER" (x0,w2) and "R" (x4,w1).
    const runs = decoSpy.mock.calls
      .map((c) => c[0])
      .map((o) => ({ x: o.x, width: o.width }))
      .sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
    expect(runs).toEqual([
      { x: 0, width: 2 },
      { x: 4, width: 1 },
    ]);
    engine.dispose();
  });

  it("disable() removes every decoration and the write listener (no leaks)", async () => {
    term = await makeTerm("plain ERROR here\r\n");

    const created: Array<{ disposed: boolean }> = [];
    const realRegister = term.registerDecoration.bind(term);
    vi.spyOn(term, "registerDecoration").mockImplementation((opts) => {
      const dec = realRegister(opts);
      if (dec) {
        const rec = { disposed: false };
        created.push(rec);
        const realDispose = dec.dispose.bind(dec);
        dec.dispose = () => {
          rec.disposed = true;
          realDispose();
        };
      }
      return dec;
    });

    const engine = new SyntaxHighlightingEngine(term);
    engine.enable([errorRule]);
    expect(created.length).toBeGreaterThan(0);

    engine.disable();
    expect(created.every((c) => c.disposed)).toBe(true);
    expect(engine.isEnabled).toBe(false);

    // After disable, further writes must not create decorations.
    const countBefore = created.length;
    await new Promise<void>((r) => term.write("another ERROR\r\n", () => r()));
    expect(created.length).toBe(countBefore);
  });

  it("does not highlight while the alternate screen buffer is active", async () => {
    // Enter alt screen, then print ERROR there.
    term = await makeTerm("\x1b[?1049h");
    const decoSpy = vi.spyOn(term, "registerDecoration");

    const engine = new SyntaxHighlightingEngine(term);
    engine.enable([errorRule]);
    await new Promise<void>((r) => term.write("ERROR in vim\r\n", () => r()));

    expect(decoSpy).not.toHaveBeenCalled();
    engine.dispose();
  });

  it("skips logical lines longer than the max length", async () => {
    term = await makeTerm("");
    const engine = new SyntaxHighlightingEngine(term, { maxLineLength: 20 });
    const decoSpy = vi.spyOn(term, "registerDecoration");

    // 30 chars then ERROR -> total > 20 -> skipped.
    const long = "x".repeat(30) + "ERROR";
    engine.enable([errorRule]);
    await new Promise<void>((r) => term.write(long + "\r\n", () => r()));

    expect(decoSpy).not.toHaveBeenCalled();
    engine.dispose();
  });

  it("updateRules recompiles and re-scans existing output", async () => {
    term = await makeTerm("plain ERROR WARN here\r\n");
    const decoSpy = vi.spyOn(term, "registerDecoration");

    const engine = new SyntaxHighlightingEngine(term);
    engine.enable([errorRule]);
    expect(decoSpy).toHaveBeenCalledTimes(1);

    decoSpy.mockClear();
    engine.updateRules([
      errorRule,
      rule({ id: "warn", pattern: "WARN", style: { color: "#cca700" } }),
    ]);
    // Now both ERROR and WARN decorate.
    expect(decoSpy).toHaveBeenCalledTimes(2);
    engine.dispose();
  });

  it("highlights new output arriving after enable", async () => {
    term = await makeTerm("first line\r\n");
    const decoSpy = vi.spyOn(term, "registerDecoration");

    const engine = new SyntaxHighlightingEngine(term);
    engine.enable([errorRule]);
    expect(decoSpy).not.toHaveBeenCalled();

    await new Promise<void>((r) => term.write("now an ERROR appears\r\n", () => r()));
    expect(decoSpy).toHaveBeenCalledTimes(1);
    expect(decoSpy.mock.calls[0][0].width).toBe(5);
    engine.dispose();
  });
});

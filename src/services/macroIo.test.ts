/**
 * Tests for reading the `macros` list of a file (#1677): what a valid file reads
 * back as, and rejection of malformed/incompatible files with clear errors.
 */
import { describe, it, expect } from "vitest";
import { MACRO_EXPORT_VERSION, parseMacroEnvelope } from "./macroIo";
import type { Macro } from "@/types/macro";
import { parseMacroStepText } from "@/components/AutomationEditor/keysFormat";

/** A `macros` file as older builds exported it. */
const serializeMacros = (macros: Macro[]) =>
  JSON.stringify({ version: MACRO_EXPORT_VERSION, macros });

function makeMacro(overrides: Partial<Macro> = {}): Macro {
  return {
    id: "macro-1",
    name: "Deploy",
    description: "Runs deploy",
    tags: ["ops"],
    steps: [{ data: "deploy\r", delayMs: 0 }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("macroIo — serialize/parse envelope", () => {
  it("round-trips a macro to an equivalent, runnable macro", () => {
    const original = makeMacro({
      steps: [
        { data: "cd /srv\r", delayMs: 0 },
        { data: "ls -la\r", delayMs: 250 },
      ],
    });
    const macros = parseMacroEnvelope(serializeMacros([original]));
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe(original.name);
    expect(macros[0].description).toBe(original.description);
    expect(macros[0].tags).toEqual(original.tags);
    expect(macros[0].steps).toEqual(original.steps);
  });

  it("round-trips hand-authored steps with control characters (PROD-039)", () => {
    // Steps as the editor produces them from typed escape notation.
    const authored = ["cd /srv\\r", "\\e[A\\r", "\\x03", "C:\\\\tmp\\t"].map((text, i) => {
      const parsed = parseMacroStepText(text);
      if (!parsed.ok) throw new Error(parsed.error);
      return { data: parsed.data, delayMs: i * 100 };
    });
    const original = makeMacro({ steps: authored });
    const [restored] = parseMacroEnvelope(serializeMacros([original]));
    expect(restored.steps).toEqual(authored);
    expect(restored.steps.map((s) => s.data)).toEqual([
      "cd /srv\r",
      "\x1b[A\r",
      "\x03",
      "C:\\tmp\t",
    ]);
  });

  it("round-trips the whole library", () => {
    const lib = [makeMacro({ id: "a", name: "A" }), makeMacro({ id: "b", name: "B" })];
    const macros = parseMacroEnvelope(serializeMacros(lib));
    expect(macros.map((m) => m.name)).toEqual(["A", "B"]);
  });

  it("tolerates a macro with no description or tags", () => {
    const macros = parseMacroEnvelope(
      JSON.stringify({
        version: MACRO_EXPORT_VERSION,
        macros: [{ name: "Bare", steps: [{ data: "x", delayMs: 0 }] }],
      })
    );
    expect(macros[0].name).toBe("Bare");
    expect(macros[0].tags).toEqual([]);
    expect(macros[0].description).toBeUndefined();
  });
});

describe("macroIo — malformed/incompatible rejection", () => {
  it("rejects invalid JSON", () => {
    expect(() => parseMacroEnvelope("{not json")).toThrow(/not valid JSON/);
  });

  it("rejects a non-object payload", () => {
    expect(() => parseMacroEnvelope("[]")).toThrow(/macro export object/);
  });

  it("rejects an unsupported version", () => {
    const json = JSON.stringify({ version: 999, macros: [] });
    expect(() => parseMacroEnvelope(json)).toThrow(/Unsupported macro file version/);
  });

  it("rejects a missing macros array", () => {
    const json = JSON.stringify({ version: MACRO_EXPORT_VERSION });
    expect(() => parseMacroEnvelope(json)).toThrow(/missing "macros" array/);
  });

  it("rejects a macro with no name", () => {
    const json = JSON.stringify({
      version: MACRO_EXPORT_VERSION,
      macros: [{ steps: [] }],
    });
    expect(() => parseMacroEnvelope(json)).toThrow(/missing a name/);
  });

  it("rejects a macro whose steps are not an array", () => {
    const json = JSON.stringify({
      version: MACRO_EXPORT_VERSION,
      macros: [{ name: "X", steps: "nope" }],
    });
    expect(() => parseMacroEnvelope(json)).toThrow(/missing its steps/);
  });

  it("rejects a malformed step", () => {
    const json = JSON.stringify({
      version: MACRO_EXPORT_VERSION,
      macros: [{ name: "X", steps: [{ delayMs: 0 }] }],
    });
    expect(() => parseMacroEnvelope(json)).toThrow(/step 0 .* is malformed/);
  });

  it("rejects a step with a negative delay", () => {
    const json = JSON.stringify({
      version: MACRO_EXPORT_VERSION,
      macros: [{ name: "X", steps: [{ data: "x", delayMs: -5 }] }],
    });
    expect(() => parseMacroEnvelope(json)).toThrow(/invalid delay/);
  });
});

describe("macroIo — zod import validation (#4386)", () => {
  const raw = (...macros: unknown[]) => JSON.stringify({ version: MACRO_EXPORT_VERSION, macros });
  const at = 'Invalid macro file: macro at index 0 ("X")';

  it.each<[string, unknown, string]>([
    ["a non-object macro", "m", "Invalid macro file: macro at index 0 is not an object."],
    [
      "a blank name",
      { name: "  ", steps: [] },
      "Invalid macro file: macro at index 0 is missing a name.",
    ],
    [
      "a non-object step",
      { name: "X", steps: [7] },
      `Invalid macro file: step 0 of macro at index 0 ("X") is malformed.`,
    ],
    [
      "a non-string data",
      { name: "X", steps: [{ data: 1, delayMs: 0 }] },
      `Invalid macro file: step 0 of macro at index 0 ("X") is malformed.`,
    ],
    [
      "a missing delay",
      { name: "X", steps: [{ data: "a" }] },
      `Invalid macro file: step 0 of macro at index 0 ("X") has an invalid delay.`,
    ],
    ["non-array tags", { name: "X", steps: [], tags: "ops" }, `${at} has malformed tags.`],
    ["a non-string tag", { name: "X", steps: [], tags: ["ops", 2] }, `${at} has malformed tags.`],
  ])("rejects %s with the exact message", (_label, macro, message) => {
    expect(() => parseMacroEnvelope(raw(macro))).toThrow(message);
  });

  it("keeps every macro field (no dropped fields)", () => {
    // Typed Required<> so a new optional Macro field must be added here too.
    const full: Required<Macro> = {
      id: "m-1",
      name: "Full",
      description: "every field",
      tags: ["a"],
      steps: [{ data: "a", delayMs: 5 }],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };
    expect(parseMacroEnvelope(serializeMacros([full]))).toStrictEqual([full]);
  });

  it("strips unknown keys on macros and steps", () => {
    const [macro] = parseMacroEnvelope(
      raw({ name: "X", steps: [{ data: "a", delayMs: 0, extra: 1 }], trusted: true })
    );
    expect(macro).not.toHaveProperty("trusted");
    expect(macro.steps).toStrictEqual([{ data: "a", delayMs: 0 }]);
  });
});

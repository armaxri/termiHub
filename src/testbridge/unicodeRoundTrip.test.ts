/**
 * Unicode round-trip coverage through the REAL in-app input handler (I18N-016).
 *
 * The test bridge's `type` command drives a real `<input>`/`<textarea>` via the
 * native value setter + an `input` event (dispatcher.ts) — the same path the
 * E2E harness uses to enter text — and `getValue` reads `el.value` back. This
 * proves representative CJK / RTL / combining-mark / astral-emoji strings
 * survive that write→read round-trip codepoint-exact, and that grapheme
 * clusters (ZWJ emoji, flags, combining sequences) are not split.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { dispatchCommand, type BridgeDeps } from "./dispatcher";

/** Representative strings spanning the Unicode planes users actually type. */
const SAMPLES: Record<string, string> = {
  "cjk-chinese": "你好世界",
  "cjk-japanese": "日本語のテスト",
  "cjk-korean": "한국어 테스트",
  "rtl-arabic": "مرحبا بالعالم",
  "rtl-hebrew": "שלום עולם",
  "bidi-mixed": "value = قيمة 42",
  // NFD "café": e + combining acute (U+0301), an astral-adjacent decomposition.
  "combining-cafe": "café",
  "combining-thai": "กิ้", // base + vowel sign + tone mark
  emoji: "🎉🚀🔥",
  "emoji-zwj-family": "👨‍👩‍👧", // ZWJ sequence: single grapheme
  "emoji-flag": "🇯🇵", // regional-indicator pair: single grapheme
  "emoji-skin-tone": "👍🏽", // base + skin-tone modifier: single grapheme
};

/** Multiline mixed-script text — only meaningful for a <textarea>, since a
 * single-line <input> strips newlines by spec (not a Unicode concern). */
const MULTILINE = "line1 你好\nlínea2 café\n行3 🎉";

// `Intl.Segmenter` is ES2022; the repo's tsconfig lib is ES2020, so declare the
// minimal surface we use here rather than widening the global lib.
interface SegmentData {
  segment: string;
}
interface Segmenter {
  segment(input: string): Iterable<SegmentData>;
}
interface SegmenterCtor {
  new (locale: string, options: { granularity: "grapheme" }): Segmenter;
}
const SegmenterImpl = (Intl as unknown as { Segmenter: SegmenterCtor }).Segmenter;
const graphemeSegmenter = new SegmenterImpl("en", { granularity: "grapheme" });

function graphemes(s: string): string[] {
  return [...graphemeSegmenter.segment(s)].map((seg) => seg.segment);
}

function setup(html: string): BridgeDeps {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  return {
    root: container,
    readTerminal: () => undefined,
    scrollTerminal: () => false,
    getTerminalViewport: () => undefined,
    getActiveTabId: () => undefined,
    getState: () => ({}),
    sendTerminalInput: async () => false,
    resizeWindow: async () => {},
    screenshot: async () => "data:image/png;base64,AAAA",
    emitEvent: async () => {},
  };
}

async function roundTrip(deps: BridgeDeps, testId: string, text: string): Promise<string> {
  const typed = await dispatchCommand({ action: "type", testId, text }, deps);
  expect(typed.ok).toBe(true);
  const read = await dispatchCommand({ action: "getValue", testId }, deps);
  expect(read.ok).toBe(true);
  return (read as { value: string }).value;
}

describe("Unicode round-trip through the input handler (I18N-016)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  for (const [name, text] of Object.entries(SAMPLES)) {
    it(`preserves "${name}" through <input> type → getValue`, async () => {
      const deps = setup(`<input data-testid="field" type="text" />`);
      const back = await roundTrip(deps, "field", text);

      // Codepoint-exact equality (default === is code-unit equal, which implies
      // codepoint equality for well-formed UTF-16).
      expect(back).toBe(text);
      // Code-point count preserved (guards against surrogate mangling).
      expect([...back]).toEqual([...text]);
      // Grapheme clusters preserved and not split.
      expect(graphemes(back)).toEqual(graphemes(text));
    });
  }

  it("preserves a multiline mixed-script string through <textarea>", async () => {
    const deps = setup(`<textarea data-testid="area"></textarea>`);
    const text = MULTILINE;
    const back = await roundTrip(deps, "area", text);
    expect(back).toBe(text);
    expect(back.split("\n")).toEqual(text.split("\n"));
  });

  it("keeps the ZWJ family emoji a single grapheme cluster (not 3 people)", () => {
    const family = SAMPLES["emoji-zwj-family"];
    expect(graphemes(family)).toEqual([family]);
    // Naive per-code-point iteration WOULD split it — this is exactly the bug
    // class the round-trip must never introduce.
    expect([...family].length).toBeGreaterThan(1);
  });
});

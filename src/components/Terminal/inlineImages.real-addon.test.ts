/**
 * Inline images against the REAL `@xterm/xterm` + `@xterm/addon-image`
 * (PROD-057, PR #3442, #4013).
 *
 * The other inline-image suites mock the addon. Here the real addon is loaded
 * through {@link createInlineImagesController} (the default lazy loader, as
 * `Terminal.tsx` uses it) into a real xterm, and a tiny SIXEL and an iTerm2 IIP
 * image are written through the real VT parser. That proves the escape
 * sequences are consumed (no noise in the text buffer), decoded and stored —
 * and, with the setting off, that nothing is stored and still no noise lands.
 *
 * jsdom limits: there is no `<canvas>` 2D context (the addon skips the paint and
 * still stores the decoded image) and no `createImageBitmap`, which the IIP path
 * uses to decode a PNG. A shim stands in for that browser decode only; header
 * parsing, base64 decoding, PNG sniffing and the store are the addon's own.
 * Painting is left to the live bridge test (`test_terminal_inline_images.py`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal as XTerm } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";
import { createInlineImagesController, type InlineImagesController } from "./inlineImages";

/** A 4×6 px red SIXEL image. */
const SIXEL = "\x1bPq#0;2;100;0;0#0~~~~-\x1b\\";
/** A 1×1 px PNG, base64. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const IIP = `\x1b]1337;File=inline=1;size=${atob(PNG_B64).length}:${PNG_B64}\x07`;

function write(term: XTerm, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()));
}

/** Every buffer line, trailing blanks trimmed, blank lines dropped. */
function bufferText(term: XTerm): string[] {
  const lines: string[] = [];
  const buffer = term.buffer.active;
  for (let i = 0; i < buffer.length; i++) {
    const text = buffer.getLine(i)?.translateToString(true) ?? "";
    if (text) lines.push(text);
  }
  return lines;
}

/** Poll `cond` (real timers) until it holds or `timeoutMs` elapses. */
async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let term: XTerm;
let host: HTMLDivElement;
let controller: InlineImagesController | null;

beforeEach(() => {
  term = new XTerm({ cols: 40, rows: 10, scrollback: 100, allowProposedApi: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  term.open(host);
  controller = null;
  // jsdom has no createImageBitmap; stand in for the browser's PNG decode.
  vi.stubGlobal(
    "createImageBitmap",
    async (_blob: Blob, opts: { resizeWidth: number; resizeHeight: number }) => ({
      width: opts.resizeWidth,
      height: opts.resizeHeight,
      close: () => {},
    })
  );
});

afterEach(() => {
  controller?.dispose();
  term.dispose();
  host.remove();
  vi.unstubAllGlobals();
});

/** Load the real addon and wait until its (async, WASM) SIXEL decoder is ready. */
async function enableImages(): Promise<InlineImagesController> {
  const c = createInlineImagesController(term, { enabled: true });
  controller = c;
  await until(() => c.isActive());
  // A probe SIXEL is stored only once the decoder has initialised.
  await until(() => {
    term.write(SIXEL);
    return c.storageUsage() > 0;
  });
  term.reset();
  return c;
}

describe("inline images with the real image addon", () => {
  it("stores a SIXEL image and keeps the escape out of the text buffer", async () => {
    const c = await enableImages();
    const before = c.storageUsage();
    await write(term, `before\r\n${SIXEL}after\r\n`);
    await until(() => c.storageUsage() > before);
    expect(bufferText(term)).toEqual(["before", "after"]);
  });

  it("stores an iTerm2 inline image and keeps the escape out of the text buffer", async () => {
    const c = await enableImages();
    const before = c.storageUsage();
    await write(term, `x${IIP}y\r\n`);
    await until(() => c.storageUsage() > before);
    expect(bufferText(term)).toEqual(["xy"]);
  });

  it("stores nothing with the setting off — and still prints no escape noise", async () => {
    const c = createInlineImagesController(term, { enabled: false });
    controller = c;
    await write(term, `before\r\n${SIXEL}mid${IIP}after\r\n`);
    expect(c.isActive()).toBe(false);
    expect(c.storageUsage()).toBe(0);
    expect(bufferText(term)).toEqual(["before", "midafter"]);
  });

  it("drops the store when the setting is turned off live", async () => {
    const c = await enableImages();
    await write(term, SIXEL);
    expect(c.storageUsage()).toBeGreaterThan(0);
    c.setEnabled(false);
    expect(c.storageUsage()).toBe(0);
    await write(term, `${SIXEL}text\r\n`);
    expect(c.storageUsage()).toBe(0);
  });

  it("keeps the text but no image data across a reconnect snapshot", async () => {
    await enableImages();
    const serialize = new SerializeAddon();
    term.loadAddon(serialize);
    await write(term, `before\r\n${SIXEL}middle ${IIP}line\r\nafter\r\n`);

    // Terminal.tsx snapshots the scrollback with the serialize addon on
    // teardown and replays it into the fresh xterm of the reconnect (#1126).
    const snapshot = serialize.serialize();
    expect(snapshot).not.toContain("\x1bPq");
    expect(snapshot).not.toContain("1337;File");

    const fresh = new XTerm({ cols: 40, rows: 10, scrollback: 100, allowProposedApi: true });
    try {
      await write(fresh, snapshot);
      expect(bufferText(fresh)).toEqual(bufferText(term));
      expect(bufferText(fresh)).toEqual(expect.arrayContaining(["before", "after"]));
    } finally {
      fresh.dispose();
    }
  });
});

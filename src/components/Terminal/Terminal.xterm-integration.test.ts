/**
 * Real xterm.js integration contract (TFE-003).
 *
 * Every `Terminal.*.test.tsx` fully mocks `@xterm/xterm` with a hand-written
 * `MockXTerm`, so the ACTUAL xterm wiring the component depends on — the real
 * VT parser, the real addon `activate()` paths, the private `_core` render
 * service, the buffer, and the event/disposable contracts — is never exercised.
 * A break there (an xterm upgrade renaming a method, restructuring `_core`, or
 * changing an event's payload) would sail past the mocked suites silently and
 * only surface as a blank/garbled terminal at runtime.
 *
 * These tests instantiate the REAL `@xterm/xterm` `Terminal` (plus the real
 * `FitAddon`/`SearchAddon`/`Unicode11Addon`/`SerializeAddon`) exactly as
 * `Terminal.tsx` constructs and wires them, and assert the behaviours the
 * component relies on — writing bytes through the real parser, buffer readback,
 * `onData`/`onResize`/`onScroll`/`onWriteParsed` firing + disposal, OSC handler
 * registration, `reset()`, addon loading, unicode v11 activation, the private
 * `_core` render-service shape, and the repo's own `createTerminalScrollbar`
 * controller driven by a real instance.
 *
 * jsdom has no layout engine and no `<canvas>` 2D context, so the two paths that
 * need real measurement CANNOT run here and are deliberately NOT asserted as
 * working: `FitAddon.proposeDimensions()` returns `undefined` (asserted below to
 * pin that gap), and the canvas/WebGL renderers never paint. Those are deferred
 * to the Python bridge E2E harness — see the follow-up issue referenced in the
 * PR. Everything below is what real xterm CAN do under jsdom, run against the
 * real library rather than a mock that can drift from it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SerializeAddon } from "@xterm/addon-serialize";
import { readRawRenderedCellWidth, getRenderedCellWidth } from "./xtermDimensions";
import { isProposedFitSafe } from "./safeFit";
import { createTerminalScrollbar } from "./terminalScrollbar";

/** Resolve when xterm has parsed `data` — the real write→parse round-trip. */
function writeAsync(term: XTerm, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()));
}

/** Read visible buffer line `row` as trimmed text via xterm's public buffer API. */
function lineText(term: XTerm, row: number): string {
  return term.buffer.active.getLine(row)?.translateToString(true) ?? "";
}

describe("real xterm integration (TFE-003)", () => {
  let term: XTerm;
  let host: HTMLDivElement;

  beforeEach(() => {
    // Mirror the option shape Terminal.tsx passes to `new XTerm({...})`.
    term = new XTerm({
      fontFamily: "monospace",
      fontSize: 14,
      lineHeight: 1.0,
      scrollback: 1000,
      cursorBlink: false,
      cursorStyle: "block",
      screenReaderMode: false,
      allowProposedApi: true,
      cols: 80,
      rows: 24,
    });
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    term.dispose();
    host.remove();
  });

  it("opens into a jsdom element and mounts its DOM (the DOM render path)", () => {
    term.open(host);
    // xterm builds its real element tree under the host — proof the DOM renderer
    // ran, not a mock that just records the open() call.
    expect(term.element).toBeInstanceOf(HTMLElement);
    expect(host.querySelector(".xterm")).not.toBeNull();
  });

  it("writes bytes through the real VT parser and reads them back from the buffer", async () => {
    term.open(host);
    await writeAsync(term, "hello world\r\n");
    expect(lineText(term, 0)).toBe("hello world");
  });

  it("processes ANSI control sequences (cursor addressing) through the real parser", async () => {
    term.open(host);
    // CUP to row 3, col 1, then write — the real parser must place the text.
    await writeAsync(term, "\x1b[3;1Hplaced");
    expect(lineText(term, 2)).toBe("placed");
  });

  it("fires onData for pasted input and disposes the listener", () => {
    term.open(host);
    let received = "";
    const disposable = term.onData((d) => {
      received += d;
    });
    term.paste("typed-input");
    expect(received).toBe("typed-input");

    disposable.dispose();
    term.paste("after-dispose");
    expect(received).toBe("typed-input");
  });

  it("resizes the real terminal and fires onResize with the new dimensions", () => {
    term.open(host);
    let evt: { cols: number; rows: number } | null = null;
    term.onResize((e) => {
      evt = e;
    });
    term.resize(100, 40);
    expect(term.cols).toBe(100);
    expect(term.rows).toBe(40);
    expect(evt).toEqual(expect.objectContaining({ cols: 100, rows: 40 }));
  });

  it("fires onWriteParsed on real output (the scrollbar's refresh trigger)", async () => {
    term.open(host);
    let parsedCount = 0;
    const disposable = term.onWriteParsed(() => {
      parsedCount += 1;
    });
    await writeAsync(term, "some output\r\n");
    expect(parsedCount).toBeGreaterThan(0);
    disposable.dispose();
  });

  it("registers an OSC 7 handler that the real parser invokes with the payload", async () => {
    term.open(host);
    let cwd: string | null = null;
    const disposable = term.parser.registerOscHandler(7, (data: string) => {
      cwd = data;
      return true;
    });
    await writeAsync(term, "\x1b]7;file://host/home/user\x07");
    expect(cwd).toBe("file://host/home/user");
    disposable.dispose();
  });

  it("clears the buffer on reset()", async () => {
    term.open(host);
    await writeAsync(term, "before reset\r\n");
    expect(lineText(term, 0)).toBe("before reset");
    term.reset();
    expect(lineText(term, 0)).toBe("");
  });

  describe("real addons (loaded exactly as Terminal.tsx does)", () => {
    it("loads FitAddon, Unicode11Addon, SearchAddon and SerializeAddon", () => {
      const fit = new FitAddon();
      const unicode11 = new Unicode11Addon();
      const search = new SearchAddon();
      const serialize = new SerializeAddon();
      // Each addon's real activate() runs inside loadAddon — none should throw.
      expect(() => {
        term.loadAddon(fit);
        term.loadAddon(unicode11);
        term.loadAddon(search);
        term.loadAddon(serialize);
      }).not.toThrow();
      term.open(host);
    });

    it("activates unicode version 11 on the real unicode service", () => {
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = "11";
      expect(term.unicode.activeVersion).toBe("11");
    });

    it("SerializeAddon serializes real written content back out", async () => {
      const serialize = new SerializeAddon();
      term.loadAddon(serialize);
      term.open(host);
      await writeAsync(term, "serialized content");
      expect(serialize.serialize()).toContain("serialized content");
    });

    it("SearchAddon finds text written into the real buffer", async () => {
      const search = new SearchAddon();
      term.loadAddon(search);
      term.open(host);
      await writeAsync(term, "find-this-token here\r\n");
      // findNext returns true when a match is located in the live buffer.
      expect(search.findNext("find-this-token")).toBe(true);
      expect(search.findNext("no-such-token-xyz")).toBe(false);
    });
  });

  describe("private _core render-service shape (xtermDimensions adapter)", () => {
    it("exposes a numeric css.cell.width on a real opened instance", () => {
      term.open(host);
      // jsdom does no measurement, so the width is legitimately 0 — but the
      // private path (`_core._renderService.dimensions.css.cell.width`) that the
      // horizontal-scroll math reads must still resolve to a NUMBER. If an xterm
      // upgrade restructures `_core`, this returns undefined and fails RED.
      expect(typeof readRawRenderedCellWidth(term)).toBe("number");
    });

    it("getRenderedCellWidth returns undefined when unmeasured under jsdom", () => {
      term.open(host);
      // width 0 (never painted) is treated as unavailable by the guarded reader.
      expect(getRenderedCellWidth(term)).toBeUndefined();
    });
  });

  describe("createTerminalScrollbar driven by a real xterm", () => {
    it("wires onScroll/onResize/onWriteParsed and disposes cleanly", () => {
      term.open(host);
      const gutter = document.createElement("div");
      const thumb = document.createElement("div");
      gutter.appendChild(thumb);
      host.appendChild(gutter);

      const controller = createTerminalScrollbar({ xterm: term, gutter, thumb });
      // Real buffer has no scrollback yet → thumb hidden. The point is that
      // update() reads the real `xterm.buffer.active` / `xterm.rows` without
      // throwing, i.e. the controller's read path matches the real API.
      expect(() => controller.update()).not.toThrow();
      expect(thumb.style.display).toBe("none");
      // dispose() must tear down the real event disposables without throwing.
      expect(() => controller.dispose()).not.toThrow();
    });
  });

  describe("browser-only measurement gap (deferred to E2E — see follow-up)", () => {
    it("FitAddon.proposeDimensions() is unavailable under jsdom, so isProposedFitSafe is false", () => {
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      // With no layout engine xterm cannot measure the container, so
      // proposeDimensions() returns undefined and the degenerate-fit guard
      // correctly refuses the fit. Real fit sizing is a browser-only path.
      expect(fit.proposeDimensions()).toBeUndefined();
      expect(isProposedFitSafe(fit)).toBe(false);
    });
  });
});

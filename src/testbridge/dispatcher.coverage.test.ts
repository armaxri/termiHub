import { describe, it, expect, vi } from "vitest";
import { dispatchCommand, readCoverageChunk, type BridgeDeps } from "./dispatcher";
import type { CoverageChunk } from "./protocol";

/** Minimal deps: the coverage verbs touch nothing but their own deps. */
function deps(overrides: Partial<BridgeDeps> = {}): BridgeDeps {
  return {
    root: document,
    readTerminal: () => undefined,
    scrollTerminal: () => false,
    getTerminalViewport: () => undefined,
    getActiveTabId: () => undefined,
    getState: () => ({}),
    sendTerminalInput: async () => false,
    resizeWindow: async () => {},
    screenshot: async () => "data:image/png;base64,AAAA",
    emitEvent: async () => {},
    ...overrides,
  };
}

const COVERAGE = { "/repo/src/a.ts": { path: "/repo/src/a.ts", s: { "0": 3 } } };

describe("readCoverage (#3657)", () => {
  it("answers null for an uninstrumented build", async () => {
    const res = await dispatchCommand({ action: "readCoverage" }, deps());
    expect(res).toEqual({ ok: true, action: "readCoverage", value: null });
  });

  it("returns the whole snapshot in one chunk when it fits", async () => {
    const res = await dispatchCommand(
      { action: "readCoverage", offset: 0 },
      deps({ getCoverage: () => COVERAGE })
    );
    const text = JSON.stringify(COVERAGE);
    expect(res).toEqual({
      ok: true,
      action: "readCoverage",
      value: { total: text.length, offset: 0, chunk: text },
    });
  });

  it("pages through one snapshot even while the counters keep moving", () => {
    const live = { f: { s: { "0": 1 } } };
    const first = readCoverageChunk(live, 0, 5) as CoverageChunk;
    live.f.s["0"] = 99; // the app keeps running between chunk reads
    const parts = [first.chunk];
    let offset = first.chunk.length;
    while (offset < first.total) {
      const next = readCoverageChunk(live, offset, 5) as CoverageChunk;
      expect(next.total).toBe(first.total);
      parts.push(next.chunk);
      offset += next.chunk.length;
    }
    expect(JSON.parse(parts.join(""))).toEqual({ f: { s: { "0": 1 } } });
  });

  it("rejects a bad offset or a continuation without a snapshot", async () => {
    expect(() => readCoverageChunk(COVERAGE, -1)).toThrow(/non-negative/);
    readCoverageChunk(undefined, 0);
    expect(() => readCoverageChunk(undefined, 10)).toThrow(/read offset 0 first/);
    readCoverageChunk(COVERAGE, 0);
    expect(() => readCoverageChunk(COVERAGE, 10_000)).toThrow(/past the snapshot/);

    const res = await dispatchCommand(
      { action: "readCoverage", offset: 1.5 },
      deps({ getCoverage: () => COVERAGE })
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("non-negative integer");
  });
});

describe("exitApp (#3657)", () => {
  it("requests the exit through the injected dep", async () => {
    const exitApp = vi.fn(async () => {});
    const res = await dispatchCommand({ action: "exitApp" }, deps({ exitApp }));
    expect(res).toEqual({ ok: true, action: "exitApp" });
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it("fails cleanly when the dep is not wired (outside the harness)", async () => {
    const res = await dispatchCommand({ action: "exitApp" }, deps());
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not available");
  });

  it("fails with the dep's error when the exit is refused", async () => {
    const exitApp = vi.fn(async () => {
      throw new Error("test bridge is not enabled");
    });
    const res = await dispatchCommand({ action: "exitApp" }, deps({ exitApp }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("test bridge is not enabled");
  });
});

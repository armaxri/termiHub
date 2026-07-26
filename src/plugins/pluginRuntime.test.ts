/**
 * Tests for the frontend plugin runtime (#1998): the `window.termihub`
 * registration surface, protocol-parser application (transform / pass-through /
 * ordering), session lifecycle hooks, the status-bar widget registry, and error
 * isolation so a throwing plugin cannot break the pipeline.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ensureTermiHubApi,
  setLoadingPlugin,
  applyParsers,
  transformOutput,
  hasProtocolParsers,
  notifySessionStart,
  notifySessionEnd,
  getStatusBarWidgets,
  subscribeStatusBarWidgets,
  unregisterPlugin,
  clearRegistry,
  type ProtocolParser,
  type StatusBarWidget,
} from "./pluginRuntime";

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

/** Register `parser` as though it came from `pluginId`'s entry point. */
function registerParserAs(pluginId: string, parser: ProtocolParser): void {
  setLoadingPlugin(pluginId);
  window.termihub.registerProtocolParser(parser);
  setLoadingPlugin(null);
}

/** Register `widget` as though it came from `pluginId`'s entry point. */
function registerWidgetAs(pluginId: string, widget: StatusBarWidget): void {
  setLoadingPlugin(pluginId);
  window.termihub.registerStatusBarWidget(widget);
  setLoadingPlugin(null);
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

beforeEach(() => {
  clearRegistry();
  ensureTermiHubApi();
});

describe("window.termihub API", () => {
  it("installs the registration API on window (idempotent)", () => {
    const first = window.termihub;
    expect(typeof first.registerProtocolParser).toBe("function");
    expect(typeof first.registerStatusBarWidget).toBe("function");
    // Re-installing returns the same object so a plugin's captured ref stays valid.
    expect(ensureTermiHubApi()).toBe(first);
  });

  it("rejects an invalid parser without registering it", () => {
    setLoadingPlugin("p");
    // Missing transform.
    window.termihub.registerProtocolParser({ id: "x", name: "x" } as unknown as ProtocolParser);
    setLoadingPlugin(null);
    expect(hasProtocolParsers()).toBe(false);
  });
});

describe("protocol parser application", () => {
  it("applies a registered parser's transform to output", () => {
    registerParserAs("colorizer", {
      id: "c",
      name: "c",
      transform: (data) => data.toUpperCase(),
    });
    expect(hasProtocolParsers()).toBe(true);
    expect(applyParsers("hello", "s1")).toEqual({ text: "HELLO", changed: true });
  });

  it("passes output through unchanged when transform returns null", () => {
    registerParserAs("noop", {
      id: "n",
      name: "n",
      transform: () => null,
    });
    const result = applyParsers("line", "s1");
    expect(result).toEqual({ text: "line", changed: false });
  });

  it("transformOutput returns the exact same bytes on pass-through", () => {
    registerParserAs("noop", { id: "n", name: "n", transform: () => null });
    const bytes = new TextEncoder().encode("unchanged");
    // Same reference => byte-exact pass-through, no re-encode.
    expect(transformOutput(bytes, "s1")).toBe(bytes);
  });

  it("transformOutput re-encodes transformed text", () => {
    registerParserAs("cap", { id: "c", name: "c", transform: (d) => d + "!" });
    const out = transformOutput(new TextEncoder().encode("hi"), "s1");
    expect(decode(out)).toBe("hi!");
  });

  it("is a no-op fast path with no parsers registered", () => {
    const bytes = new TextEncoder().encode("raw");
    expect(transformOutput(bytes, "s1")).toBe(bytes);
  });

  it("chains parsers in registration order, each seeing the prior output", () => {
    registerParserAs("a", { id: "a", name: "a", transform: (d) => d + "-a" });
    registerParserAs("b", { id: "b", name: "b", transform: (d) => d + "-b" });
    expect(applyParsers("x", "s1")).toEqual({ text: "x-a-b", changed: true });
  });

  it("passes sessionId through to transform", () => {
    const seen: string[] = [];
    registerParserAs("p", {
      id: "p",
      name: "p",
      transform: (_d, sid) => {
        seen.push(sid);
        return null;
      },
    });
    applyParsers("x", "session-42");
    expect(seen).toEqual(["session-42"]);
  });
});

describe("session lifecycle hooks", () => {
  it("invokes onSessionStart / onSessionEnd for registered parsers", () => {
    const start = vi.fn();
    const end = vi.fn();
    registerParserAs("p", {
      id: "p",
      name: "p",
      transform: () => null,
      onSessionStart: start,
      onSessionEnd: end,
    });
    notifySessionStart("s1");
    notifySessionEnd("s1");
    expect(start).toHaveBeenCalledWith("s1");
    expect(end).toHaveBeenCalledWith("s1");
  });

  it("tolerates parsers without lifecycle hooks", () => {
    registerParserAs("p", { id: "p", name: "p", transform: () => null });
    expect(() => {
      notifySessionStart("s1");
      notifySessionEnd("s1");
    }).not.toThrow();
  });
});

describe("error isolation", () => {
  it("a throwing transform is skipped and the next parser still runs", () => {
    registerParserAs("bad", {
      id: "bad",
      name: "bad",
      transform: () => {
        throw new Error("boom");
      },
    });
    registerParserAs("good", { id: "good", name: "good", transform: (d) => d + "!" });
    // Bad parser is skipped; good parser still applies.
    expect(applyParsers("x", "s1")).toEqual({ text: "x!", changed: true });
  });

  it("a throwing onSessionStart does not break other parsers", () => {
    const good = vi.fn();
    registerParserAs("bad", {
      id: "bad",
      name: "bad",
      transform: () => null,
      onSessionStart: () => {
        throw new Error("boom");
      },
    });
    registerParserAs("good", {
      id: "good",
      name: "good",
      transform: () => null,
      onSessionStart: good,
    });
    expect(() => notifySessionStart("s1")).not.toThrow();
    expect(good).toHaveBeenCalledWith("s1");
  });
});

describe("status-bar widget registry", () => {
  const widget = (id: string, position: "left" | "right"): StatusBarWidget => ({
    id,
    position,
    render: () => document.createElement("span"),
    dispose: () => {},
  });

  it("projects widgets to their side with collision-proof keys", () => {
    registerWidgetAs("p1", widget("clock", "left"));
    registerWidgetAs("p2", widget("clock", "right"));
    const left = getStatusBarWidgets("left");
    const right = getStatusBarWidgets("right");
    expect(left.map((e) => e.key)).toEqual(["p1:clock"]);
    expect(right.map((e) => e.key)).toEqual(["p2:clock"]);
  });

  it("returns a stable reference until the registry changes", () => {
    const before = getStatusBarWidgets("left");
    expect(getStatusBarWidgets("left")).toBe(before);
    registerWidgetAs("p1", widget("clock", "left"));
    expect(getStatusBarWidgets("left")).not.toBe(before);
  });

  it("notifies subscribers on registration and unregistration", () => {
    const listener = vi.fn();
    const unsub = subscribeStatusBarWidgets(listener);
    registerWidgetAs("p1", widget("clock", "left"));
    expect(listener).toHaveBeenCalledTimes(1);
    unregisterPlugin("p1");
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
    registerWidgetAs("p2", widget("cpu", "left"));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid widget (bad position)", () => {
    setLoadingPlugin("p");
    window.termihub.registerStatusBarWidget({
      id: "x",
      position: "middle",
      render: () => document.createElement("span"),
      dispose: () => {},
    } as unknown as StatusBarWidget);
    setLoadingPlugin(null);
    expect(getStatusBarWidgets("left")).toHaveLength(0);
    expect(getStatusBarWidgets("right")).toHaveLength(0);
  });
});

describe("unregisterPlugin", () => {
  it("removes only the given plugin's parsers and widgets", () => {
    registerParserAs("keep", { id: "k", name: "k", transform: (d) => d + "k" });
    registerParserAs("drop", { id: "d", name: "d", transform: (d) => d + "d" });
    registerWidgetAs("drop", {
      id: "w",
      position: "left",
      render: () => document.createElement("span"),
      dispose: () => {},
    });

    unregisterPlugin("drop");

    expect(applyParsers("x", "s1")).toEqual({ text: "xk", changed: true });
    expect(getStatusBarWidgets("left")).toHaveLength(0);
  });
});

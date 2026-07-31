/**
 * Tests for the sandbox worker runtime core (#2136): the per-plugin registration
 * surface, protocol-parser application (transform / pass-through / ordering),
 * session lifecycle hooks, the widget event emitter, the parsers-active signal,
 * and error isolation so a throwing plugin cannot break the pipeline.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ensureTermiHubApi,
  makePluginApi,
  applyParsers,
  transformChunk,
  hasProtocolParsers,
  notifySessionStart,
  notifySessionEnd,
  subscribeWidgetEvents,
  subscribeParsersActive,
  unregisterPlugin,
  clearRegistry,
  type ProtocolParser,
  type StatusBarWidget,
  type WidgetEvent,
} from "./pluginRuntimeCore";

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn(), onFrontendLog: vi.fn() }));

/** Register `parser` through `pluginId`'s own API instance, as its wrapper does. */
function registerParserAs(pluginId: string, parser: ProtocolParser): void {
  makePluginApi(pluginId).registerProtocolParser(parser);
}

/** Register `widget` through `pluginId`'s own API instance, as its wrapper does. */
function registerWidgetAs(pluginId: string, widget: StatusBarWidget): void {
  makePluginApi(pluginId).registerStatusBarWidget(widget);
}

/** A minimal valid widget rendering a text span descriptor. */
const widget = (id: string, position: "left" | "right" = "left"): StatusBarWidget => ({
  id,
  position,
  render: () => ({ tag: "span", text: id }),
  dispose: () => {},
});

const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const encode = (s: string) => new TextEncoder().encode(s);

/** Collect widget events for the duration of a test. */
let widgetEvents: WidgetEvent[];
let unsubWidgets: () => void;

beforeEach(() => {
  clearRegistry();
  widgetEvents = [];
  unsubWidgets?.();
  unsubWidgets = subscribeWidgetEvents((e) => widgetEvents.push(e));
});

describe("plugin API surface", () => {
  it("installs the registration API on a target global (idempotent)", () => {
    const target: Record<string, unknown> = {};
    const first = ensureTermiHubApi(target);
    expect(typeof (first as { registerProtocolParser: unknown }).registerProtocolParser).toBe(
      "function"
    );
    expect(typeof target.__termihubMakePluginApi).toBe("function");
    expect(ensureTermiHubApi(target)).toBe(first);
  });

  it("rejects an invalid parser without registering it", () => {
    makePluginApi("p").registerProtocolParser({ id: "x", name: "x" } as unknown as ProtocolParser);
    expect(hasProtocolParsers()).toBe(false);
  });
});

describe("per-plugin API instance", () => {
  it("attributes each instance's registrations to its own plugin id", () => {
    makePluginApi("plugin-a").registerProtocolParser({
      id: "shared",
      name: "a",
      transform: (d) => d + "-a",
    });
    makePluginApi("plugin-b").registerProtocolParser({
      id: "shared",
      name: "b",
      transform: (d) => d + "-b",
    });
    expect(applyParsers("x", "s1")).toEqual({ text: "x-a-b", changed: true });

    unregisterPlugin("plugin-a");
    expect(applyParsers("x", "s1")).toEqual({ text: "x-b", changed: true });
  });

  it("attributes an async (setTimeout) registration to the right plugin and unregisters it", async () => {
    const api = makePluginApi("async-plugin");
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        api.registerProtocolParser({ id: "late", name: "late", transform: (d) => d + "!" });
        api.registerStatusBarWidget(widget("late-widget"));
        resolve();
      }, 0);
    });

    expect(applyParsers("hi", "s1")).toEqual({ text: "hi!", changed: true });
    expect(widgetEvents).toContainEqual(
      expect.objectContaining({ type: "upsert", key: "async-plugin:late-widget" })
    );

    unregisterPlugin("async-plugin");
    expect(hasProtocolParsers()).toBe(false);
    expect(widgetEvents).toContainEqual({ type: "remove", key: "async-plugin:late-widget" });
  });
});

describe("protocol parser application", () => {
  it("applies a registered parser's transform to output", () => {
    registerParserAs("colorizer", { id: "c", name: "c", transform: (d) => d.toUpperCase() });
    expect(hasProtocolParsers()).toBe(true);
    expect(applyParsers("hello", "s1")).toEqual({ text: "HELLO", changed: true });
  });

  it("passes output through unchanged when transform returns null", () => {
    registerParserAs("noop", { id: "n", name: "n", transform: () => null });
    expect(applyParsers("line", "s1")).toEqual({ text: "line", changed: false });
  });

  it("transformChunk reports pass-through without re-encoding", () => {
    registerParserAs("noop", { id: "n", name: "n", transform: () => null });
    expect(transformChunk(encode("unchanged"), "s1")).toEqual({ changed: false });
  });

  it("transformChunk re-encodes transformed text", () => {
    registerParserAs("cap", { id: "c", name: "c", transform: (d) => d + "!" });
    const result = transformChunk(encode("hi"), "s1");
    expect(result.changed).toBe(true);
    expect(result.changed && decode(result.bytes)).toBe("hi!");
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

describe("parsers-active signal", () => {
  it("emits only on transitions between zero and non-zero parsers", () => {
    const active = vi.fn();
    const unsub = subscribeParsersActive(active);
    registerParserAs("a", { id: "a", name: "a", transform: (d) => d });
    registerParserAs("b", { id: "b", name: "b", transform: (d) => d });
    expect(active).toHaveBeenCalledTimes(1);
    expect(active).toHaveBeenLastCalledWith(true);
    unregisterPlugin("a");
    expect(active).toHaveBeenCalledTimes(1); // still one parser → no transition
    unregisterPlugin("b");
    expect(active).toHaveBeenCalledTimes(2);
    expect(active).toHaveBeenLastCalledWith(false);
    unsub();
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
    expect(applyParsers("x", "s1")).toEqual({ text: "x!", changed: true });
  });

  it("a widget whose render() throws emits no upsert", () => {
    registerWidgetAs("bad", {
      id: "bad",
      position: "left",
      render: () => {
        throw new Error("boom");
      },
      dispose: () => {},
    });
    expect(widgetEvents).toHaveLength(0);
  });
});

describe("status-bar widget events", () => {
  it("emits an upsert with the rendered descriptor and a collision-proof key", () => {
    registerWidgetAs("p1", widget("clock", "left"));
    expect(widgetEvents).toEqual([
      {
        type: "upsert",
        key: "p1:clock",
        pluginId: "p1",
        widgetId: "clock",
        position: "left",
        node: { tag: "span", text: "clock" },
      },
    ]);
  });

  it("rejects an invalid widget (bad position)", () => {
    makePluginApi("p").registerStatusBarWidget({
      id: "x",
      position: "middle",
      render: () => ({ tag: "span" }),
      dispose: () => {},
    } as unknown as StatusBarWidget);
    expect(widgetEvents).toHaveLength(0);
  });

  it("disposes and emits remove on unregister", () => {
    const dispose = vi.fn();
    registerWidgetAs("p", { ...widget("cpu"), dispose });
    unregisterPlugin("p");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(widgetEvents).toContainEqual({ type: "remove", key: "p:cpu" });
  });
});

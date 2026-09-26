/**
 * Loads the shipped example JavaScript plugins (`examples/plugins/`) through the
 * sandbox runtime exactly as the worker does (PROD-051), so the samples that
 * `docs/plugin-authoring.md` points authors at can never silently rot.
 *
 * Each sample's `frontend/index.js` is wrapped in the same per-plugin loader
 * IIFE the `plugin://` protocol serves (`wrap_plugin_source` in
 * `src-tauri/src/plugin_protocol.rs`) and evaluated against a worker-like global
 * that only exposes the per-plugin API bridge — no DOM, no `window`, no IPC.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyParsers,
  clearRegistry,
  hasProtocolParsers,
  makePluginApi,
  subscribeWidgetEvents,
  unregisterPlugin,
  type WidgetEvent,
} from "./sandbox/pluginRuntimeCore";

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn(), onFrontendLog: vi.fn() }));

interface ExampleManifest {
  id: string;
  permissions: string[];
  extensions: {
    protocolParser?: { entryPoint: string };
    statusBarWidget?: { entryPoint: string; position: string };
  };
}

const EXAMPLES = resolve(process.cwd(), "examples", "plugins");

function readManifest(dir: string): ExampleManifest {
  return JSON.parse(readFileSync(resolve(EXAMPLES, dir, "manifest.json"), "utf8"));
}

/**
 * Wrap `body` byte-for-byte like the `plugin://` protocol's wrapped mode and run
 * it against a worker-like global exposing only the per-plugin API bridge.
 */
function loadInSandbox(pluginId: string, body: string): void {
  const wrapped =
    "(function (termihub) {\n" +
    body +
    `\n})((self.__termihubMakePluginApi ? self.__termihubMakePluginApi(${JSON.stringify(
      pluginId
    )}) : self.termihub));`;
  const workerSelf = { __termihubMakePluginApi: makePluginApi };
  // The loader only ever sees `self`; shadow the real globals it must not rely on.
  new Function("self", "window", "document", wrapped)(workerSelf, undefined, undefined);
}

/** Load an example plugin directory's declared entry point into the sandbox. */
function loadExample(dir: string, entryPoint: string): ExampleManifest {
  const manifest = readManifest(dir);
  loadInSandbox(manifest.id, readFileSync(resolve(EXAMPLES, dir, entryPoint), "utf8"));
  return manifest;
}

let events: WidgetEvent[];
let unsubscribe: () => void;

beforeEach(() => {
  clearRegistry();
  events = [];
  unsubscribe = subscribeWidgetEvents((e) => events.push(e));
});

afterEach(() => {
  unsubscribe();
  vi.useRealTimers();
});

describe("examples/plugins/log-highlighter (protocol parser)", () => {
  it("declares only a protocolParser with the terminal permission", () => {
    const manifest = readManifest("log-highlighter");
    expect(manifest.extensions.protocolParser?.entryPoint).toBe("frontend/index.js");
    expect(manifest.extensions.statusBarWidget).toBeUndefined();
    expect(manifest.permissions).toEqual(["terminal"]);
  });

  it("registers a parser that colors ERROR and WARN", () => {
    loadExample("log-highlighter", "frontend/index.js");
    expect(hasProtocolParsers()).toBe(true);

    const { text, changed } = applyParsers("ERROR disk full; WARN low memory", "s1");
    expect(changed).toBe(true);
    expect(text).toBe("\u001b[31mERROR\u001b[0m disk full; \u001b[33mWARN\u001b[0m low memory");
  });

  it("passes chunks without a log level through unchanged", () => {
    loadExample("log-highlighter", "frontend/index.js");
    expect(applyParsers("all good here", "s1")).toEqual({ text: "all good here", changed: false });
    // Whole-word, upper-case only: these must not be touched.
    expect(applyParsers("ERRORS and WARNING", "s1").changed).toBe(false);
  });

  it("is removed when the plugin is unloaded", () => {
    const { id } = loadExample("log-highlighter", "frontend/index.js");
    unregisterPlugin(id);
    expect(hasProtocolParsers()).toBe(false);
  });
});

describe("examples/plugins/clock-widget (status-bar widget)", () => {
  it("declares only a right-side statusBarWidget with the ui permission", () => {
    const manifest = readManifest("clock-widget");
    expect(manifest.extensions.statusBarWidget).toEqual({
      entryPoint: "frontend/index.js",
      position: "right",
    });
    expect(manifest.extensions.protocolParser).toBeUndefined();
    expect(manifest.permissions).toEqual(["ui"]);
  });

  it("renders the current time as a declarative node and refreshes it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 2, 9, 5, 0));
    loadExample("clock-widget", "frontend/index.js");

    expect(events).toHaveLength(1);
    const first = events[0];
    expect(first).toMatchObject({
      type: "upsert",
      key: "clock-widget:clock-widget",
      pluginId: "clock-widget",
      position: "right",
      node: { tag: "span", text: "09:05" },
    });

    vi.setSystemTime(new Date(2026, 0, 2, 9, 6, 0));
    vi.advanceTimersByTime(30_000);
    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: "upsert", node: { text: "09:06" } });
  });

  it("stops its timer and is removed when the plugin is unloaded", () => {
    vi.useFakeTimers();
    const { id } = loadExample("clock-widget", "frontend/index.js");
    unregisterPlugin(id);
    expect(events[events.length - 1]).toEqual({ type: "remove", key: "clock-widget:clock-widget" });

    const count = events.length;
    vi.advanceTimersByTime(120_000);
    expect(events).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });
});

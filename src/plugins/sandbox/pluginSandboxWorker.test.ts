// @vitest-environment node
/**
 * Tests for the plugin sandbox **worker** message loop (#2136, #4385 / TFE2-007).
 *
 * The worker module runs its side effects at import time against the worker
 * global (`self`): it installs the plugin API, wires the runtime-core event
 * subscriptions to `postMessage`, registers the `message` listener and posts
 * `ready`. These tests stub `self` (addEventListener / postMessage /
 * importScripts) with `vi.stubGlobal`, dynamic-import the real module with a
 * fresh module graph per test, and drive the real message loop — no fake of the
 * worker side. `importScripts` is stubbed to run "plugin sources" that behave
 * like the protocol's wrapped loader IIFE: they resolve their own API instance
 * via `self.__termihubMakePluginApi(<id>)`.
 *
 * The last block wires the real host ({@link ./pluginSandboxHost}) to the real
 * worker through an in-memory bridge, so both halves of the protocol are tested
 * together rather than each against its own fake.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type {
  HostToWorkerMessage,
  ProtocolParser,
  StatusBarWidget,
  TermiHubPluginAPI,
  WorkerToHostMessage,
} from "./protocol";

/** A stand-in for the worker global the module under test talks to. */
interface FakeWorkerGlobal {
  posted: { message: WorkerToHostMessage; transfer?: Transferable[] }[];
  handler: ((e: MessageEvent<HostToWorkerMessage>) => void) | null;
  /** Plugin "sources" keyed by URL, run by the stubbed `importScripts`. */
  scripts: Map<string, () => void>;
  importScripts: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  termihub?: TermiHubPluginAPI;
  __termihubMakePluginApi?: (pluginId: string) => TermiHubPluginAPI;
}

let g: FakeWorkerGlobal;

function makeWorkerGlobal(): FakeWorkerGlobal {
  const global: FakeWorkerGlobal = {
    posted: [],
    handler: null,
    scripts: new Map(),
    importScripts: vi.fn((...urls: string[]) => {
      for (const url of urls) {
        const run = global.scripts.get(url);
        // Mirror the browser: a missing script is a NetworkError thrown out of
        // importScripts (the protocol's 404 for a missing file).
        if (!run) throw new Error(`NetworkError: Failed to load '${url}'`);
        run();
      }
    }),
    postMessage: vi.fn((message: WorkerToHostMessage, transfer?: Transferable[]) => {
      global.posted.push({ message, transfer });
    }),
    addEventListener: vi.fn(
      (type: string, handler: (e: MessageEvent<HostToWorkerMessage>) => void) => {
        if (type === "message") global.handler = handler;
      }
    ),
  };
  return global;
}

/** Fresh module graph + fresh worker global, then import the worker module. */
async function bootWorker(): Promise<void> {
  vi.resetModules();
  g = makeWorkerGlobal();
  vi.stubGlobal("self", g);
  await import("./pluginSandboxWorker");
}

/** Deliver a host → worker message to the worker's real `message` handler. */
function send(message: HostToWorkerMessage): void {
  if (!g.handler) throw new Error("worker registered no message handler");
  g.handler({ data: message } as MessageEvent<HostToWorkerMessage>);
}

/** Every posted message, in order. */
function messages(): WorkerToHostMessage[] {
  return g.posted.map((p) => p.message);
}

/** Posted messages of one type. */
function postedOfType<T extends WorkerToHostMessage["t"]>(
  t: T
): Extract<WorkerToHostMessage, { t: T }>[] {
  return messages().filter((m): m is Extract<WorkerToHostMessage, { t: T }> => m.t === t);
}

/** Register a plugin source that, when imported, runs `body` with its own API. */
function definePlugin(url: string, pluginId: string, body: (api: TermiHubPluginAPI) => void): void {
  g.scripts.set(url, () => {
    // What the protocol's wrapped loader IIFE does (#2020/#2266).
    const api = g.__termihubMakePluginApi!(pluginId);
    body(api);
  });
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function upperParser(overrides: Partial<ProtocolParser> = {}): ProtocolParser {
  return {
    id: "upper",
    name: "Upper",
    transform: (data) => data.toUpperCase(),
    ...overrides,
  };
}

describe("pluginSandboxWorker message loop", () => {
  beforeEach(async () => {
    await bootWorker();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts ready on boot, after registering its message listener", () => {
    expect(g.addEventListener).toHaveBeenCalledWith("message", expect.any(Function));
    expect(messages()).toEqual([{ t: "ready" }]);
    // The listener must exist before `ready` so no host message can be missed.
    expect(g.addEventListener.mock.invocationCallOrder[0]).toBeLessThan(
      g.postMessage.mock.invocationCallOrder[0]
    );
  });

  it("installs the plugin API and per-plugin bridge on the worker global", () => {
    expect(typeof g.termihub?.registerProtocolParser).toBe("function");
    expect(typeof g.__termihubMakePluginApi).toBe("function");
  });

  describe("load", () => {
    it("imports each entry URL in order", () => {
      const order: string[] = [];
      definePlugin("plugin://load/p/a.js", "p", () => order.push("a"));
      definePlugin("plugin://load/p/b.js", "p", () => order.push("b"));

      send({
        t: "load",
        pluginId: "p",
        entryUrls: ["plugin://load/p/a.js", "plugin://load/p/b.js"],
      });

      expect(order).toEqual(["a", "b"]);
      expect(g.importScripts).toHaveBeenNthCalledWith(1, "plugin://load/p/a.js");
      expect(g.importScripts).toHaveBeenNthCalledWith(2, "plugin://load/p/b.js");
      expect(postedOfType("loadError")).toEqual([]);
    });

    it("turns an importScripts failure into a loadError post instead of throwing", () => {
      expect(() =>
        send({ t: "load", pluginId: "missing", entryUrls: ["plugin://load/missing/x.js"] })
      ).not.toThrow();

      expect(postedOfType("loadError")).toEqual([
        {
          t: "loadError",
          pluginId: "missing",
          message: "NetworkError: Failed to load 'plugin://load/missing/x.js'",
        },
      ]);
    });

    it("reports a top-level runtime error in plugin code as loadError", () => {
      g.scripts.set("plugin://load/bad/index.js", () => {
        throw new TypeError("undefined is not a function");
      });

      send({ t: "load", pluginId: "bad", entryUrls: ["plugin://load/bad/index.js"] });

      expect(postedOfType("loadError")).toEqual([
        { t: "loadError", pluginId: "bad", message: "undefined is not a function" },
      ]);
    });

    it("stringifies a non-Error throw in the loadError message", () => {
      g.scripts.set("plugin://load/odd/index.js", () => {
        throw "plain string";
      });

      send({ t: "load", pluginId: "odd", entryUrls: ["plugin://load/odd/index.js"] });

      expect(postedOfType("loadError")).toEqual([
        { t: "loadError", pluginId: "odd", message: "plain string" },
      ]);
    });

    it("keeps loading the remaining entry points after one fails", () => {
      const ran: string[] = [];
      definePlugin("plugin://load/p/ok.js", "p", () => ran.push("ok"));

      send({
        t: "load",
        pluginId: "p",
        entryUrls: ["plugin://load/p/gone.js", "plugin://load/p/ok.js"],
      });

      expect(ran).toEqual(["ok"]);
      expect(postedOfType("loadError")).toHaveLength(1);
      expect(postedOfType("loadError")[0].pluginId).toBe("p");
    });

    it("relays a parser registration as parsersActive", () => {
      definePlugin("plugin://load/p/index.js", "p", (api) =>
        api.registerProtocolParser(upperParser())
      );

      send({ t: "load", pluginId: "p", entryUrls: ["plugin://load/p/index.js"] });

      expect(postedOfType("parsersActive")).toEqual([{ t: "parsersActive", active: true }]);
    });

    it("relays a widget registration as widgetUpsert with the rendered node", () => {
      const widget: StatusBarWidget = {
        id: "clock",
        position: "right",
        render: () => ({ tag: "span", text: "12:00" }),
        dispose: vi.fn(),
      };
      definePlugin("plugin://load/w/index.js", "w", (api) => api.registerStatusBarWidget(widget));

      send({ t: "load", pluginId: "w", entryUrls: ["plugin://load/w/index.js"] });

      const upserts = postedOfType("widgetUpsert");
      expect(upserts).toHaveLength(1);
      expect(upserts[0]).toMatchObject({
        t: "widgetUpsert",
        position: "right",
        widgetId: "clock",
        node: { tag: "span", text: "12:00" },
      });
      expect(typeof upserts[0].key).toBe("string");
    });
  });

  describe("transform", () => {
    it("passes a chunk through (changed:false) when no parser is registered", () => {
      send({ t: "transform", seq: 7, sessionId: "s1", bytes: enc.encode("hello") });

      expect(g.posted[g.posted.length - 1]).toEqual({
        message: { t: "transformResult", seq: 7, changed: false },
        transfer: undefined,
      });
    });

    it("replies changed:true with the transformed bytes and transfers their buffer", () => {
      definePlugin("plugin://load/p/index.js", "p", (api) =>
        api.registerProtocolParser(upperParser())
      );
      send({ t: "load", pluginId: "p", entryUrls: ["plugin://load/p/index.js"] });

      send({ t: "transform", seq: 3, sessionId: "s1", bytes: enc.encode("hello") });

      const last = g.posted[g.posted.length - 1]!;
      expect(last.message).toMatchObject({ t: "transformResult", seq: 3, changed: true });
      const reply = last.message as Extract<WorkerToHostMessage, { t: "transformResult" }>;
      expect(dec.decode(reply.bytes)).toBe("HELLO");
      expect(last.transfer).toEqual([reply.bytes!.buffer]);
      // The transfer list is accepted by a real structured clone (detaches it).
      const buffer = reply.bytes!.buffer;
      structuredClone(last.message, { transfer: last.transfer });
      expect(buffer.byteLength).toBe(0);
    });

    it("passes the session id to the parser and echoes each seq", () => {
      const seen: string[] = [];
      definePlugin("plugin://load/p/index.js", "p", (api) =>
        api.registerProtocolParser(
          upperParser({
            transform: (data, sessionId) => {
              seen.push(sessionId);
              return data === "skip" ? null : data.toUpperCase();
            },
          })
        )
      );
      send({ t: "load", pluginId: "p", entryUrls: ["plugin://load/p/index.js"] });

      send({ t: "transform", seq: 1, sessionId: "a", bytes: enc.encode("x") });
      send({ t: "transform", seq: 2, sessionId: "b", bytes: enc.encode("skip") });

      expect(seen).toEqual(["a", "b"]);
      const results = postedOfType("transformResult");
      expect(results.map((r) => [r.seq, r.changed])).toEqual([
        [1, true],
        [2, false],
      ]);
    });

    it("isolates a throwing parser: the chunk passes through and the error is logged", () => {
      definePlugin("plugin://load/p/index.js", "p", (api) =>
        api.registerProtocolParser(
          upperParser({
            transform: () => {
              throw new Error("parser exploded");
            },
          })
        )
      );
      send({ t: "load", pluginId: "p", entryUrls: ["plugin://load/p/index.js"] });

      expect(() =>
        send({ t: "transform", seq: 9, sessionId: "s", bytes: enc.encode("hi") })
      ).not.toThrow();

      expect(postedOfType("transformResult")).toEqual([
        { t: "transformResult", seq: 9, changed: false },
      ]);
      // The runtime core's error log is bridged back to the host as a log post.
      expect(postedOfType("log").some((l) => l.message.includes("parser exploded"))).toBe(true);
    });
  });

  describe("unload", () => {
    it("drops the plugin's parsers (parsersActive false) and stops transforming", () => {
      definePlugin("plugin://load/p/index.js", "p", (api) =>
        api.registerProtocolParser(upperParser())
      );
      send({ t: "load", pluginId: "p", entryUrls: ["plugin://load/p/index.js"] });

      send({ t: "unload", pluginId: "p" });
      send({ t: "transform", seq: 4, sessionId: "s", bytes: enc.encode("hello") });

      expect(postedOfType("parsersActive")).toEqual([
        { t: "parsersActive", active: true },
        { t: "parsersActive", active: false },
      ]);
      expect(postedOfType("transformResult")).toEqual([
        { t: "transformResult", seq: 4, changed: false },
      ]);
    });

    it("disposes the plugin's widgets and posts widgetRemove for each", () => {
      const dispose = vi.fn();
      definePlugin("plugin://load/w/index.js", "w", (api) =>
        api.registerStatusBarWidget({
          id: "clock",
          position: "left",
          render: () => ({ tag: "span" }),
          dispose,
        })
      );
      send({ t: "load", pluginId: "w", entryUrls: ["plugin://load/w/index.js"] });
      const key = postedOfType("widgetUpsert")[0].key;

      send({ t: "unload", pluginId: "w" });

      expect(dispose).toHaveBeenCalledTimes(1);
      expect(postedOfType("widgetRemove")).toEqual([{ t: "widgetRemove", key }]);
    });

    it("leaves other plugins' parsers in place", () => {
      definePlugin("plugin://load/a/index.js", "a", (api) =>
        api.registerProtocolParser(upperParser())
      );
      definePlugin("plugin://load/b/index.js", "b", () => {});
      send({ t: "load", pluginId: "a", entryUrls: ["plugin://load/a/index.js"] });
      send({ t: "load", pluginId: "b", entryUrls: ["plugin://load/b/index.js"] });

      send({ t: "unload", pluginId: "b" });
      send({ t: "transform", seq: 5, sessionId: "s", bytes: enc.encode("x") });

      expect(postedOfType("transformResult")[0].changed).toBe(true);
    });
  });

  describe("session hooks", () => {
    it("dispatches sessionStart / sessionEnd to the parser lifecycle hooks", () => {
      const onSessionStart = vi.fn();
      const onSessionEnd = vi.fn();
      definePlugin("plugin://load/p/index.js", "p", (api) =>
        api.registerProtocolParser(upperParser({ onSessionStart, onSessionEnd }))
      );
      send({ t: "load", pluginId: "p", entryUrls: ["plugin://load/p/index.js"] });

      send({ t: "sessionStart", sessionId: "s1" });
      expect(onSessionStart).toHaveBeenCalledWith("s1");
      expect(onSessionEnd).not.toHaveBeenCalled();

      send({ t: "sessionEnd", sessionId: "s1" });
      expect(onSessionEnd).toHaveBeenCalledWith("s1");
    });

    it("isolates a throwing session hook and logs it back to the host", () => {
      definePlugin("plugin://load/p/index.js", "p", (api) =>
        api.registerProtocolParser(
          upperParser({
            onSessionStart: () => {
              throw new Error("hook failed");
            },
          })
        )
      );
      send({ t: "load", pluginId: "p", entryUrls: ["plugin://load/p/index.js"] });

      expect(() => send({ t: "sessionStart", sessionId: "s1" })).not.toThrow();
      expect(postedOfType("log").some((l) => l.message.includes("hook failed"))).toBe(true);
    });
  });

  describe("log bridge", () => {
    it("forwards frontendLog output from the worker realm as log posts", async () => {
      // Same module graph as the booted worker (no resetModules since boot).
      const { frontendLog } = await import("@/utils/frontendLog");

      frontendLog("my_plugin", "hello from the sandbox");

      expect(postedOfType("log")).toContainEqual({
        t: "log",
        message: "frontend::my_plugin: hello from the sandbox",
      });
    });
  });

  describe("malformed messages", () => {
    it("ignores an unknown message type without posting or throwing", () => {
      const before = g.posted.length;
      expect(() => send({ t: "bogus" } as unknown as HostToWorkerMessage)).not.toThrow();
      expect(g.posted).toHaveLength(before);
    });

    it.each([
      ["null", null],
      ["undefined", undefined],
      ["a string", "load"],
      ["a number", 42],
    ])("ignores %s message data instead of throwing out of the handler", (_label, data) => {
      // An exception escaping the handler surfaces on the host as a worker
      // `error` event, which the host treats as a fault and tears the sandbox
      // down — so a junk message must be dropped, not thrown.
      const before = g.posted.length;
      expect(() =>
        g.handler!({ data } as unknown as MessageEvent<HostToWorkerMessage>)
      ).not.toThrow();
      expect(g.posted).toHaveLength(before);
    });
  });
});

// ─── Host ⇄ worker, wired together ───────────────────────────────────────────

describe("pluginSandboxHost driving the real worker", () => {
  /** Flush pending macrotasks so bridged (async) messages are delivered. */
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  let host: typeof import("./pluginSandboxHost");
  let widgetStore: typeof import("./statusBarWidgetStore");
  let hostLog: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    // Host and worker share one module graph here, unlike the two real realms.
    // Stub the logger so the worker's log bridge cannot echo the host's own
    // `log` relays back into the worker in a loop.
    hostLog = vi.fn();
    vi.doMock("@/utils/frontendLog", () => ({ frontendLog: hostLog, onFrontendLog: vi.fn() }));

    g = makeWorkerGlobal();
    vi.stubGlobal("self", g);

    host = await import("./pluginSandboxHost");
    widgetStore = await import("./statusBarWidgetStore");

    // A Worker whose postMessage goes into the real worker module, with real
    // structured-clone (+ transfer) semantics and asynchronous delivery both ways.
    let hostHandler: ((e: MessageEvent<WorkerToHostMessage>) => void) | null = null;
    const toHostQueue: WorkerToHostMessage[] = [];
    const deliverToHost = () => {
      while (hostHandler && toHostQueue.length > 0) {
        hostHandler({ data: toHostQueue.shift()! } as MessageEvent<WorkerToHostMessage>);
      }
    };
    g.postMessage.mockImplementation((message: WorkerToHostMessage, transfer?: Transferable[]) => {
      g.posted.push({ message, transfer });
      toHostQueue.push(structuredClone(message, { transfer: transfer ?? [] }));
      setTimeout(deliverToHost, 0);
    });

    let workerBooted = false;
    host.__setSandboxWorkerFactory(() => {
      if (!workerBooted) throw new Error("worker module not booted");
      return {
        addEventListener: (
          type: string,
          handler: (e: MessageEvent<WorkerToHostMessage>) => void
        ) => {
          if (type === "message") {
            hostHandler = handler;
            setTimeout(deliverToHost, 0);
          }
        },
        postMessage: (message: HostToWorkerMessage, transfer?: Transferable[]) => {
          const cloned = structuredClone(message, { transfer: transfer ?? [] });
          setTimeout(() => send(cloned), 0);
        },
        terminate: () => {
          hostHandler = null;
        },
      } as unknown as Worker;
    });

    await import("./pluginSandboxWorker");
    workerBooted = true;
  });

  afterEach(() => {
    host.__resetSandboxHost();
    host.__setSandboxWorkerFactory(null);
    vi.doUnmock("@/utils/frontendLog");
    vi.unstubAllGlobals();
  });

  it("loads a parser plugin and runs output through the real transform round-trip", async () => {
    definePlugin("plugin://load/p/index.js", "p", (api) =>
      api.registerProtocolParser(upperParser())
    );

    host.loadPluginInSandbox("p", ["plugin://load/p/index.js"]);
    await flush();
    await flush();
    expect(host.sandboxHasParsers()).toBe(true);

    const out: string[] = [];
    host.enqueueSandboxTransform("s1", enc.encode("hello"), (b) => out.push(dec.decode(b)));
    host.enqueueSandboxTransform("s1", enc.encode(" world"), (b) => out.push(dec.decode(b)));
    await flush();
    await flush();

    expect(out).toEqual(["HELLO", " WORLD"]);
    expect(host.sandboxSessionPending("s1")).toBe(false);
  });

  it("surfaces a plugin load failure through the host log, keeping the sandbox up", async () => {
    host.loadPluginInSandbox("gone", ["plugin://load/gone/index.js"]);
    await flush();
    await flush();

    expect(hostLog).toHaveBeenCalledWith(
      "plugin_sandbox",
      expect.stringContaining('Plugin "gone" failed to execute in the sandbox')
    );
    expect(host.sandboxLoadedCount()).toBe(1);
  });

  it("materialises a worker-rendered widget in the host store and removes it on unload", async () => {
    const dispose = vi.fn();
    definePlugin("plugin://load/w/index.js", "w", (api) =>
      api.registerStatusBarWidget({
        id: "clock",
        position: "right",
        render: () => ({ tag: "span", text: "12:00" }),
        dispose,
      })
    );
    // Keep the worker alive past the widget plugin's unload.
    definePlugin("plugin://load/keep/index.js", "keep", () => {});

    host.loadPluginInSandbox("keep", ["plugin://load/keep/index.js"]);
    host.loadPluginInSandbox("w", ["plugin://load/w/index.js"]);
    await flush();
    await flush();

    expect(widgetStore.getStatusBarWidgets("right")).toEqual([
      expect.objectContaining({ widgetId: "clock", node: { tag: "span", text: "12:00" } }),
    ]);

    host.unloadPluginFromSandbox("w");
    await flush();
    await flush();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(widgetStore.getStatusBarWidgets("right")).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  CSP_PLATFORMS,
  effectiveCsp,
  readTauriConfig,
  toCspMap,
  type CspPlatform,
} from "@/test/tauriCsp";

/**
 * Static guards on the shipped Content-Security-Policy (#2048/#2059/#3627).
 *
 * These assert invariants on `tauri.conf.json` (the base production CSP), the
 * per-platform overlay `tauri.windows.conf.json`, and the system-test build's
 * runtime `connect-src` widening (`test_bridge.rs`, #3628) as plain data, so an accidental loosening
 * fails fast in per-PR CI without a full app build. The runtime "app boots +
 * terminal renders + zero violations under the CSP" check lives in the
 * integration lane (`tests/system/tests/test_csp.py`).
 *
 * The allow-list below is the reviewed sign-off for every source the shipped
 * policy carries (WA-CI-035, recorded in docs/architecture.md → "The policy").
 * A new directive or source anywhere in the effective policy of any platform
 * fails this test until it is added here **with a reason** and documented.
 */

interface AllowedSource {
  /** Why the source is needed — the evidence reviewed in #3627. */
  reason: string;
  /** Restrict the source to these platforms. Omitted = every platform. */
  platforms?: readonly CspPlatform[];
}

const ALLOW_LIST: Record<string, Record<string, AllowedSource>> = {
  "default-src": { "'self'": { reason: "baseline: only the app's own bundle" } },
  "script-src": {
    "'self'": { reason: "the app's own bundle" },
    "plugin://localhost": {
      reason: "frontend-plugin sandbox importScripts origin (custom scheme on WebKit)",
      platforms: ["macos", "linux"],
    },
    "http://plugin.localhost": {
      reason: "frontend-plugin sandbox importScripts origin (WebView2 form of the scheme)",
      platforms: ["windows"],
    },
    "'wasm-unsafe-eval'": {
      reason: "Shiki's Oniguruma engine and @xterm/addon-image's sixel decoder instantiate WASM",
    },
  },
  "style-src": {
    "'self'": { reason: "bundled stylesheets" },
    "'unsafe-inline'": {
      reason:
        "runtime <style> elements (xterm, Monaco, sonner, react-remove-scroll) and React style props",
    },
  },
  "img-src": {
    "'self'": { reason: "bundled images" },
    "data:": { reason: "Monaco's stylesheet embeds data: SVG/PNG backgrounds" },
    "blob:": { reason: "@xterm/addon-image renders inline (iTerm2/sixel) images from blob URLs" },
  },
  "font-src": { "'self'": { reason: "bundled Geist / Meslo / codicon fonts" } },
  "connect-src": {
    "'self'": { reason: "same-origin fetches" },
    "ipc:": {
      reason: "Tauri IPC custom protocol, WebKit form (ipc://localhost/<cmd>)",
      platforms: ["macos", "linux"],
    },
    "http://ipc.localhost": {
      reason: "Tauri IPC custom protocol, WebView2 form (http://ipc.localhost/<cmd>)",
      platforms: ["windows"],
    },
  },
  "worker-src": {
    "'self'": { reason: "Monaco's bundled workers (#3632) and the plugin sandbox worker" },
    "blob:": { reason: "no known consumer since #3632; removal tracked in #3639" },
  },
  "child-src": {
    "'self'": { reason: "worker fallback for engines without worker-src" },
    "blob:": { reason: "worker fallback for engines without worker-src" },
  },
  "object-src": { "'none'": { reason: "no plugins/embeds" } },
  "frame-src": { "'none'": { reason: "no frames" } },
  "base-uri": { "'self'": { reason: "no <base> hijack" } },
  "form-action": { "'none'": { reason: "no form submissions" } },
};

/** Sources that must never appear in any directive, whatever the allow-list says. */
const FORBIDDEN_EVERYWHERE = ["'unsafe-eval'", "*", "http:", "https:", "ws:", "wss:"];

describe.each(CSP_PLATFORMS)("production CSP on %s", (platform) => {
  const csp = effectiveCsp(platform);

  it("carries only allow-listed directives and sources", () => {
    const unexpected: string[] = [];
    for (const [directive, sources] of Object.entries(csp)) {
      const allowed = ALLOW_LIST[directive];
      if (!allowed) {
        unexpected.push(`${directive} (directive not on the allow-list)`);
        continue;
      }
      for (const source of sources) {
        const entry = allowed[source];
        if (!entry || (entry.platforms && !entry.platforms.includes(platform))) {
          unexpected.push(`${directive} ${source}`);
        }
      }
    }
    expect(
      unexpected,
      "unreviewed CSP relaxation — add it to ALLOW_LIST with a reason and document it in " +
        "docs/architecture.md, or remove it"
    ).toEqual([]);
  });

  it("carries every directive of the reviewed baseline", () => {
    expect(Object.keys(csp).sort()).toEqual(Object.keys(ALLOW_LIST).sort());
  });

  it("never carries a forbidden source", () => {
    for (const [directive, sources] of Object.entries(csp)) {
      for (const bad of FORBIDDEN_EVERYWHERE) {
        expect(sources, `${directive} must not allow ${bad}`).not.toContain(bad);
      }
    }
  });

  it("has no 'unsafe-inline', 'unsafe-eval' or blob: in script-src", () => {
    expect(csp["script-src"]).toBeDefined();
    expect(csp["script-src"]).not.toContain("'unsafe-inline'");
    expect(csp["script-src"]).not.toContain("'unsafe-eval'");
    // Plugin code loads from the plugin:// origin, not a blob: URL (#2266).
    expect(csp["script-src"]).not.toContain("blob:");
  });

  it("allows exactly this platform's plugin origin in script-src (#2266/#3627)", () => {
    // Tauri assigns the custom scheme a different webview origin per platform.
    // Only the native form is allowed, so macOS/Linux never trust a loopback
    // http://plugin.localhost server and Windows never lists a dead scheme.
    const expected = platform === "windows" ? "http://plugin.localhost" : "plugin://localhost";
    const other = platform === "windows" ? "plugin://localhost" : "http://plugin.localhost";
    expect(csp["script-src"]).toContain(expected);
    expect(csp["script-src"]).not.toContain(other);
  });

  it("allows exactly this platform's IPC origin in connect-src (#3628)", () => {
    // Tauri's IPC script fetches `http://ipc.localhost/<cmd>` on Windows and
    // `ipc://localhost/<cmd>` on WebKit (convertFileSrc in tauri/scripts/core.js).
    const expected = platform === "windows" ? "http://ipc.localhost" : "ipc:";
    const other = platform === "windows" ? "ipc:" : "http://ipc.localhost";
    expect(csp["connect-src"]).toEqual(["'self'", expected]);
    expect(csp["connect-src"]).not.toContain(other);
  });

  it("allows no WebSocket origin in connect-src — the bridge allowance is test-only (#2059)", () => {
    expect(csp["connect-src"]).toBeDefined();
    expect(csp["connect-src"].some((s) => s.startsWith("ws://") || s.startsWith("wss://"))).toBe(
      false
    );
  });

  it("keeps object-src / frame-src locked down", () => {
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(csp["frame-src"]).toEqual(["'none'"]);
  });

  it("keeps the worker substrate (worker-src / child-src 'self' blob:) available", () => {
    expect(csp["worker-src"]).toEqual(["'self'", "blob:"]);
    expect(csp["child-src"]).toEqual(["'self'", "blob:"]);
  });
});

describe("platform overlays", () => {
  it("the base config is a directive map, so overlays can patch single directives", () => {
    const base = readTauriConfig("tauri.conf.json") as {
      app: { security: { csp: unknown } };
    };
    const csp = base.app.security.csp;
    expect(typeof csp === "object" && csp !== null && !Array.isArray(csp)).toBe(true);
  });

  it("the Windows overlay touches only script-src and connect-src", () => {
    const win = readTauriConfig("tauri.windows.conf.json") as {
      app: { security: Record<string, unknown> };
    };
    expect(Object.keys(win)).toEqual(expect.arrayContaining(["app"]));
    expect(Object.keys(win.app)).toEqual(["security"]);
    expect(Object.keys(win.app.security)).toEqual(["csp"]);
    expect(
      Object.keys(toCspMap(win.app.security.csp as Parameters<typeof toCspMap>[0])).sort()
    ).toEqual(["connect-src", "script-src"]);
  });

  it("no macOS/Linux overlay changes the CSP (none exists today)", () => {
    for (const platform of ["macos", "linux"] as const) {
      const conf = readTauriConfig(`tauri.${platform}.conf.json`) as {
        app?: { security?: { csp?: unknown } };
      } | null;
      expect(conf?.app?.security?.csp, `tauri.${platform}.conf.json`).toBeUndefined();
    }
  });
});

describe("test-build CSP", () => {
  it("has no config overlay — the bridge widens connect-src at runtime instead (#3628)", () => {
    // A `--config` overlay would replace the whole connect-src array on every
    // platform, so it could not keep each platform's own IPC origin.
    expect(readTauriConfig("tauri.test.conf.json")).toBeNull();
  });
});

describe.each(CSP_PLATFORMS)("test-build CSP (runtime bridge widening) on %s", (platform) => {
  const prod = effectiveCsp(platform);
  const test = effectiveCsp(platform, { testBuild: true });

  it("keeps this platform's IPC origin and only it", () => {
    const expected = platform === "windows" ? "http://ipc.localhost" : "ipc:";
    const other = platform === "windows" ? "ipc:" : "http://ipc.localhost";
    expect(test["connect-src"]).toContain(expected);
    expect(test["connect-src"]).not.toContain(other);
  });

  it("adds ONLY the loopback ws:// bridge allowance to connect-src", () => {
    const added = test["connect-src"].filter((s) => !prod["connect-src"].includes(s));
    const removed = prod["connect-src"].filter((s) => !test["connect-src"].includes(s));
    expect(added).toEqual(["ws://127.0.0.1:*", "ws://localhost:*"]);
    expect(removed).toEqual([]);
  });

  it("is otherwise identical to production — every non-connect-src directive matches", () => {
    const directives = new Set([...Object.keys(prod), ...Object.keys(test)]);
    for (const d of directives) {
      if (d === "connect-src") continue;
      expect(test[d], `directive ${d} drifted between prod and test CSP`).toEqual(prod[d]);
    }
  });
});

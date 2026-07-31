import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guards on the shipped Content-Security-Policy (#2048/#2059).
 *
 * These assert invariants on `tauri.conf.json` (the production CSP) and
 * `tauri.test.conf.json` (the test-build overlay) as plain data, so an
 * accidental loosening — a re-added `ws://`, an `'unsafe-inline'`/`'unsafe-eval'`
 * creeping into `script-src` — fails fast in per-PR CI, without needing a full
 * app build. The runtime "app boots + terminal renders + zero violations under
 * the CSP" check lives in the integration lane (`tests/system/tests/test_csp.py`).
 */

function readCsp(relPath: string): string {
  // Vitest runs with the repo root as cwd, so the config lives at src-tauri/<file>.
  const path = resolve(process.cwd(), "src-tauri", relPath);
  const conf = JSON.parse(readFileSync(path, "utf8")) as {
    app: { security: { csp: string } };
  };
  return conf.app.security.csp;
}

/** Parse a CSP string into a `directive -> sources[]` map. */
function parseCsp(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const clause of csp.split(";")) {
    const [directive, ...sources] = clause.trim().split(/\s+/).filter(Boolean);
    if (directive) out[directive] = sources;
  }
  return out;
}

const prodCsp = readCsp("tauri.conf.json");
const testCsp = readCsp("tauri.test.conf.json");
const prod = parseCsp(prodCsp);
const test = parseCsp(testCsp);

describe("production CSP (tauri.conf.json)", () => {
  it("has no 'unsafe-inline' or 'unsafe-eval' in script-src", () => {
    expect(prod["script-src"]).toBeDefined();
    expect(prod["script-src"]).not.toContain("'unsafe-inline'");
    expect(prod["script-src"]).not.toContain("'unsafe-eval'");
  });

  it("allows no WebSocket (ws://) origin in connect-src — the bridge allowance is test-only (#2059)", () => {
    expect(prod["connect-src"]).toBeDefined();
    expect(prod["connect-src"].some((s) => s.startsWith("ws://") || s.startsWith("wss://"))).toBe(
      false
    );
  });

  it("keeps object-src / frame-src locked down", () => {
    expect(prod["object-src"]).toEqual(["'none'"]);
    expect(prod["frame-src"]).toEqual(["'none'"]);
  });

  it("keeps the Worker sandbox substrate (worker-src / child-src 'self' blob:) available", () => {
    // Frontend plugins execute in a Web Worker loaded from 'self', running plugin
    // code from a blob URL inside the worker (#2136). This locks that substrate so
    // a later CSP tidy-up cannot silently remove it. `blob:` in `script-src`
    // stays for now — dropping it is the deferred final step of #2136.
    expect(prod["worker-src"]).toEqual(["'self'", "blob:"]);
    expect(prod["child-src"]).toEqual(["'self'", "blob:"]);
  });
});

describe("test-build CSP overlay (tauri.test.conf.json)", () => {
  it("re-adds ONLY the loopback ws:// bridge allowance to connect-src", () => {
    const added = test["connect-src"].filter((s) => !prod["connect-src"].includes(s));
    expect(added).toEqual(["ws://127.0.0.1:*", "ws://localhost:*"]);
  });

  it("is otherwise byte-identical to production — every non-connect-src directive matches", () => {
    // Drift lock: editing the production CSP must be mirrored in the overlay, or
    // the test build would ship a different rendering-relevant policy than prod.
    const directives = new Set([...Object.keys(prod), ...Object.keys(test)]);
    for (const d of directives) {
      if (d === "connect-src") continue;
      expect(test[d], `directive ${d} drifted between prod and test CSP`).toEqual(prod[d]);
    }
  });
});

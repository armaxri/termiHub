import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static guards on the webview's Tauri capability set (SEC-013 / #3115).
 *
 * `src-tauri/capabilities/*.json` decides which plugin commands the webview may
 * call and on which paths / URLs. These tests read it as plain data, so an
 * accidental widening fails fast in per-PR CI without an app build.
 *
 * The fs and opener plugins are the sensitive ones:
 *
 * - **fs** — the webview may only `readTextFile` / `writeTextFile`, and only on
 *   paths a native open/save dialog returned: the dialog plugin adds the picked
 *   path to the fs scope at runtime. No static scope is granted at all, so the
 *   webview cannot read or write the app's own config, data or logs (the
 *   backend owns those) or any other path.
 * - **opener** — only `openUrl` on `http` / `https` / `mailto` URLs. Opening a
 *   local folder goes through the backend's validated `local_open_folder`
 *   command (directories only), never the plugin's `open_path` / reveal.
 *
 * The allow-list below is the reviewed sign-off for every permission the
 * capability carries (recorded in docs/architecture.md → "Content-Security-Policy
 * & capability scoping"). A new permission fails this test until it is added
 * here **with a reason** and documented.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CAPABILITIES_DIR = join(REPO_ROOT, "src-tauri", "capabilities");

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Capability {
  identifier: string;
  windows?: string[];
  permissions: (string | { identifier: string; allow?: Json[]; deny?: Json[] })[];
}

/** Every permission the webview may carry, each with the reason it is needed. */
const ALLOWED_PERMISSIONS: Record<string, string> = {
  "core:default": "Tauri core (events, window, app, path) — the baseline every app needs",
  "opener:allow-open-url":
    "external links (About, licences, plugin pages, installers, embedded HTTP servers); scoped below",
  "dialog:default": "native open/save/message dialogs; a pick is what extends the fs scope",
  "fs:allow-read-text-file": "read a file the user picked in a native open dialog (imports)",
  "fs:allow-write-text-file": "write a file the user picked in a native save dialog (exports)",
  "fs:deny-default": "explicitly denies the webview-data folders, even if a pick lands there",
  "clipboard-manager:default": "clipboard plugin baseline",
  "clipboard-manager:allow-read-text": "terminal / editor paste",
  "clipboard-manager:allow-write-text": "terminal / editor copy",
  "core:webview:allow-set-webview-zoom": "UI zoom setting",
  "core:window:allow-set-size": "window size restore",
  "core:window:allow-destroy": "closing secondary windows",
  "core:window:allow-close": "closing windows",
};

/** The only URL schemes `opener:allow-open-url` may open (mirrors safeOpenExternal.ts). */
const ALLOWED_OPEN_URL_SCOPES = ["http://*", "https://*", "mailto:*"];

function readCapabilities(): { file: string; capability: Capability }[] {
  return readdirSync(CAPABILITIES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((file) => ({
      file,
      capability: JSON.parse(readFileSync(join(CAPABILITIES_DIR, file), "utf8")) as Capability,
    }));
}

function permissionId(p: Capability["permissions"][number]): string {
  return typeof p === "string" ? p : p.identifier;
}

function allPermissions(): Capability["permissions"] {
  return readCapabilities().flatMap(({ capability }) => capability.permissions);
}

describe("Tauri capability scoping (#3115)", () => {
  it("has exactly one capability file, the reviewed default", () => {
    expect(readCapabilities().map(({ file }) => file)).toEqual(["default.json"]);
  });

  it("carries only reviewed permissions", () => {
    const unreviewed = allPermissions()
      .map(permissionId)
      .filter((id) => !(id in ALLOWED_PERMISSIONS));
    expect(unreviewed).toEqual([]);
  });

  it("grants the fs plugin no static path scope", () => {
    const fs = allPermissions().filter((p) => permissionId(p).startsWith("fs:"));
    // Command-only permissions plus the deny set: no `fs:default` (which reads
    // $APPCONFIG / $APPDATA / … recursively), no `fs:scope-*`, no `*-recursive`
    // or `read-all` / `write-all` sets, and no inline `allow` path list.
    expect(fs.map(permissionId).sort()).toEqual([
      "fs:allow-read-text-file",
      "fs:allow-write-text-file",
      "fs:deny-default",
    ]);
    for (const p of fs)
      expect(typeof p, `${permissionId(p)} must not carry a scope`).toBe("string");
  });

  it("does not let the webview open or reveal local paths", () => {
    const ids = allPermissions().map(permissionId);
    for (const banned of [
      "opener:default",
      "opener:allow-open-path",
      "opener:allow-reveal-item-in-dir",
      "opener:allow-default-urls",
    ]) {
      expect(ids, banned).not.toContain(banned);
    }
  });

  it("scopes openUrl to http, https and mailto", () => {
    const openUrl = allPermissions().filter((p) => permissionId(p) === "opener:allow-open-url");
    expect(openUrl).toHaveLength(1);
    const entry = openUrl[0];
    if (typeof entry === "string") throw new Error("opener:allow-open-url must carry a URL scope");
    expect(entry.deny ?? []).toEqual([]);
    const urls = (entry.allow ?? []).map((a) => {
      const scope = a as { url?: string; path?: string };
      expect(scope.path, "openUrl must not carry a path scope").toBeUndefined();
      return scope.url;
    });
    expect([...urls].sort()).toEqual([...ALLOWED_OPEN_URL_SCOPES].sort());
  });

  it("adds no fs / opener scope through tauri.conf.json", () => {
    for (const file of readdirSync(join(REPO_ROOT, "src-tauri")).filter((f) =>
      /^tauri(\.[a-z]+)?\.conf\.json$/.test(f)
    )) {
      const conf = JSON.parse(readFileSync(join(REPO_ROOT, "src-tauri", file), "utf8")) as {
        plugins?: Record<string, Json>;
        app?: { security?: { assetProtocol?: Json } };
      };
      expect(conf.plugins?.fs, `${file}: plugins.fs`).toBeUndefined();
      expect(conf.plugins?.opener, `${file}: plugins.opener`).toBeUndefined();
      expect(conf.app?.security?.assetProtocol, `${file}: assetProtocol`).toBeUndefined();
    }
  });
});

/** Every non-test frontend source file under `src/`. */
function frontendSources(dir = join(REPO_ROOT, "src")): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : frontendSources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("frontend use of the fs / opener plugins (#3115)", () => {
  // ESLint's no-restricted-imports covers static imports; a dynamic
  // `import("@tauri-apps/plugin-fs")` slips past it, so check those here.
  it("never imports the fs or opener plugin dynamically", () => {
    const offenders = frontendSources()
      .filter((path) =>
        /import\(\s*["']@tauri-apps\/plugin-(fs|opener)["']\s*\)/.test(readFileSync(path, "utf8"))
      )
      .map((path) => relative(REPO_ROOT, path));
    expect(offenders).toEqual([]);
  });

  it("uses only readTextFile / writeTextFile from the fs plugin and openUrl from the opener", () => {
    const allowed: Record<string, string[]> = {
      fs: ["readTextFile", "writeTextFile"],
      opener: ["openUrl"],
    };
    const offenders: string[] = [];
    for (const path of frontendSources()) {
      const source = readFileSync(path, "utf8");
      const imports = source.matchAll(
        /import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']@tauri-apps\/plugin-(fs|opener)["']/g
      );
      for (const [, typeOnly, names, plugin] of imports) {
        if (typeOnly) continue;
        for (const raw of names.split(",")) {
          const name = raw
            .trim()
            .replace(/^type\s+/, "")
            .split(/\s+as\s+/)[0];
          if (name && !raw.trim().startsWith("type ") && !allowed[plugin].includes(name)) {
            offenders.push(`${relative(REPO_ROOT, path)}: ${name} from plugin-${plugin}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, relative, sep } from "path";
import { fileURLToPath } from "url";
import {
  CONNECTION_STATE_SURFACES,
  RETIRED_CONNECTION_STATE_WORDS,
  connectionStateHeading,
  connectionStateWord,
  connectionVerb,
  verbForState,
  type ConnectionState,
} from "./connectionStateCopy";
import { t, type MessageId } from "@/i18n/catalog";

/**
 * One wording for connection states (#6159). The words come from one map, and
 * every surface that shows a connection's state (the sidebar, tabs, the status
 * bar, overlays and toasts) takes them from it instead of typing its own.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = join(SRC_DIR, "..");

/** Where the words themselves live: the catalog and the map that reads it. */
const SOURCES = new Set(["i18n/catalog.ts", "utils/connectionStateCopy.ts"]);

/** Every production `.ts`/`.tsx` file under `src/`, tests and generated types excluded. */
function productionFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "generated" || name === "test" || name === "__mocks__") continue;
      productionFiles(path, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

/** Comments removed, so a sentence that explains the old wording is not copy. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Whether `source` shows `text` as a whole string or a whole JSX text. */
function showsText(source: string, text: string): boolean {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const literal = new RegExp(`(["'\`])${escaped}\\.?\\1`);
  const jsx = new RegExp(`>\\s*${escaped}\\.?\\s*<`);
  return literal.test(source) || jsx.test(source);
}

const STATES: ConnectionState[] = [
  "connecting",
  "connected",
  "reconnecting",
  "failed",
  "ended",
  "notConnected",
];

describe("connection-state words", () => {
  it("names each state once", () => {
    expect(STATES.map(connectionStateWord)).toEqual([
      "Connecting",
      "Connected",
      "Reconnecting",
      "Connection failed",
      "Session ended",
      "Not connected",
    ]);
  });

  it("gives what lasts an ellipsis and what rests none", () => {
    expect(connectionStateHeading("connecting")).toBe("Connecting…");
    expect(connectionStateHeading("reconnecting")).toBe("Reconnecting…");
    expect(connectionStateHeading("failed")).toBe("Connection failed");
    expect(connectionStateHeading("ended")).toBe("Session ended");
  });

  it("offers one verb per state", () => {
    expect(STATES.map((s) => [s, verbForState(s)])).toEqual([
      ["connecting", "cancel"],
      ["connected", null],
      ["reconnecting", "stopReconnecting"],
      ["failed", "retry"],
      ["ended", "reconnect"],
      ["notConnected", "connect"],
    ]);
    expect(connectionVerb("retry")).toBe("Retry");
    expect(connectionVerb("reconnect")).toBe("Reconnect");
    expect(connectionVerb("stopReconnecting")).toBe("Stop reconnecting");
    expect(connectionVerb("cancel")).toBe("Cancel");
    expect(connectionVerb("connect")).toBe("Connect");
  });
});

describe("every surface uses the map", () => {
  it.each(CONNECTION_STATE_SURFACES)("%s takes its words from connectionStateCopy", (file) => {
    const path = join(SRC_DIR, file);
    expect(existsSync(path), `${file} is listed but does not exist`).toBe(true);
    expect(readFileSync(path, "utf8")).toMatch(/from "@\/utils\/connectionStateCopy"/);
  });

  it("lists the sidebar, tabs, the status bar, overlays and toasts", () => {
    const areas = CONNECTION_STATE_SURFACES.map((f) => f.split("/").slice(0, 2).join("/"));
    for (const area of [
      "components/Sidebar",
      "components/Terminal",
      "components/StatusBar",
      "components/RemoteDesktop",
    ]) {
      expect(areas).toContain(area);
    }
    // Toasts: the connect flow's "Connecting…" and the editor's failed Test.
    expect(CONNECTION_STATE_SURFACES).toContain("utils/connectSavedConnection.ts");
    expect(CONNECTION_STATE_SURFACES).toContain("components/ConnectionEditor/ConnectionEditor.tsx");
  });

  it("no other file types a state word, heading or verb of its own", () => {
    const words = [
      ...STATES.filter((s) => s !== "connecting" && s !== "connected" && s !== "reconnecting").map(
        connectionStateWord
      ),
      connectionStateHeading("connecting"),
      connectionStateHeading("reconnecting"),
      connectionVerb("stopReconnecting"),
      ...RETIRED_CONNECTION_STATE_WORDS,
    ];
    const offenders: string[] = [];
    for (const path of productionFiles(SRC_DIR)) {
      const file = relative(SRC_DIR, path).split(sep).join("/");
      if (SOURCES.has(file)) continue;
      const source = withoutComments(readFileSync(path, "utf8"));
      for (const word of words) {
        if (showsText(source, word)) offenders.push(`${file}: "${word}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the catalog says no retired word", () => {
    const catalog = readFileSync(join(SRC_DIR, "i18n/catalog.ts"), "utf8");
    const values = [...catalog.matchAll(/^\s*"([\w.]+)":\s*$|^\s*"([\w.]+)":\s*"/gm)]
      .map((m) => (m[1] ?? m[2]) as MessageId)
      .map((id) => t(id))
      .filter((v): v is string => typeof v === "string");
    const retired = values.filter((v) =>
      RETIRED_CONNECTION_STATE_WORDS.some((w) => v === w || v.startsWith(`${w}.`))
    );
    expect(retired).toEqual([]);
  });

  it("the copy guide states every word", () => {
    const guide = readFileSync(join(REPO_DIR, "docs/copy-style.md"), "utf8");
    for (const s of STATES) expect(guide).toContain(connectionStateWord(s));
    for (const v of ["retry", "reconnect", "stopReconnecting", "cancel", "connect"] as const) {
      expect(guide).toContain(connectionVerb(v));
    }
    expect(guide).toMatch(/## Glossary/);
    expect(guide).toMatch(/## Connection states/);
  });
});

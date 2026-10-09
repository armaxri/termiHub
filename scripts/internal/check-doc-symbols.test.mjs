import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import {
  checkDoc,
  checkRepo,
  definesSymbol,
  extractReferences,
  findLineAnchors,
  resolveFile,
} from "./check-doc-symbols.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SOURCES = {
  "src-tauri/src/session_projection/store.rs": [
    "pub use termihub_core::connection::lifecycle::SessionStatus;",
    "pub struct SessionLifecycleStore {",
    "impl SessionLifecycleStore {",
    "    pub fn connect_auth_failed(&self) {}",
    "}",
  ].join("\n"),
  "core/src/reconnect_backoff.rs": "pub fn reconnect_reducer(state: S) -> S { state }",
};
const read = (rel) => SOURCES[rel] ?? null;

describe("extractReferences", () => {
  it("finds `file` → `Symbol` pairs with either arrow", () => {
    const refs = extractReferences("see `a/b.rs` → `Foo::bar` and `c.ts` -> `baz`");
    expect(refs).toEqual([
      { file: "a/b.rs", symbol: "Foo::bar", line: 1 },
      { file: "c.ts", symbol: "baz", line: 1 },
    ]);
  });
});

describe("findLineAnchors", () => {
  it("flags file:line anchors", () => {
    expect(findLineAnchors("x (`store.rs:47-83`) y")).toEqual([{ anchor: "store.rs:47", line: 1 }]);
  });
});

describe("resolveFile", () => {
  it("resolves a bare base name to the unique cited full path", () => {
    expect(resolveFile("store.rs", ["x/store.rs", "y/timer.rs"])).toBe("x/store.rs");
  });
  it("returns null for an ambiguous or unknown base name", () => {
    expect(resolveFile("store.rs", ["x/store.rs", "y/store.rs"])).toBeNull();
    expect(resolveFile("nope.rs", ["x/store.rs"])).toBeNull();
  });
});

describe("definesSymbol", () => {
  it("accepts Rust items and re-exports", () => {
    const src = SOURCES["src-tauri/src/session_projection/store.rs"];
    expect(definesSymbol(src, "SessionLifecycleStore")).toBe(true);
    expect(definesSymbol(src, "SessionStatus")).toBe(true);
    expect(definesSymbol(src, "connect_auth_failed")).toBe(true);
  });
  it("rejects a name that is only mentioned, not defined", () => {
    expect(definesSymbol("let x = SessionLifecycle::new();", "SessionLifecycle")).toBe(false);
  });
});

describe("checkDoc", () => {
  const good = [
    "| `src-tauri/src/session_projection/store.rs` → `SessionLifecycleStore` |",
    "and `store.rs` → `SessionLifecycleStore::connect_auth_failed`,",
    "and `core/src/reconnect_backoff.rs` → `reconnect_reducer`.",
  ].join("\n");

  it("passes when every reference resolves", () => {
    expect(checkDoc("doc.md", good, read)).toEqual([]);
  });

  it("reports a renamed symbol", () => {
    const problems = checkDoc("doc.md", good.replace("reconnect_reducer", "old_reducer"), read);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("`old_reducer`");
  });

  it("reports a moved file", () => {
    const problems = checkDoc("doc.md", good.replace("core/src/reconnect", "core/src/gone"), read);
    expect(problems[0]).toContain("does not exist");
  });

  it("reports a reintroduced line anchor", () => {
    const problems = checkDoc("doc.md", `${good}\n(\`store.rs:251\`)`, read);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("drift-prone line anchor");
  });
});

describe("the real repo", () => {
  it("has no doc code-reference drift", () => {
    const { problems, references } = checkRepo(ROOT);
    expect(problems).toEqual([]);
    expect(references).toBeGreaterThan(0);
  });
});

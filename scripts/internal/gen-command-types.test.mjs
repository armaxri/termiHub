// @vitest-environment node
// TypeScript-compiler work only: no DOM needed.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { OUTPUT, collectCommands, generate, invokeFiles, render } from "./gen-command-types.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2020",
    module: "ESNext",
    moduleResolution: "bundler",
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    baseUrl: ".",
    paths: { "@/*": ["./src/*"] },
  },
  include: ["src"],
});

const INVOKE_DTS = `export declare function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;`;

/** A tiny repository with the given `src/` files. */
function fixture(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "gen-command-types-"));
  writeFileSync(path.join(root, "tsconfig.json"), TSCONFIG);
  const shim = path.join(root, "node_modules", "@tauri-apps", "api");
  mkdirSync(shim, { recursive: true });
  writeFileSync(path.join(shim, "core.d.ts"), INVOKE_DTS);
  writeFileSync(
    path.join(shim, "package.json"),
    JSON.stringify({ name: "@tauri-apps/api", exports: { "./core": { types: "./core.d.ts" } } })
  );
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

const roots = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function commandsOf(files) {
  const root = fixture(files);
  roots.push(root);
  return { root, text: render(root) };
}

describe("gen-command-types (#6151)", () => {
  it("records each command's argument and result types, importing named types", () => {
    const { text } = commandsOf({
      "src/types/file.ts": "export interface FileEntry { name: string; size: number }",
      "src/services/api.ts": `
        import { invoke } from "@tauri-apps/api/core";
        import type { FileEntry } from "@/types/file";
        export const stat = (path: string) => invoke<FileEntry>("local_stat", { path });
        export const list = () => invoke<FileEntry[]>("local_list");
        export const remove = (path: string, force?: boolean) => invoke("local_remove", { path, force });
      `,
    });
    expect(text).toContain('import type { FileEntry } from "@/types/file";');
    expect(text).toContain("local_stat: { args: { path: string }; result: FileEntry };");
    expect(text).toContain("local_list: { args: undefined; result: Array<FileEntry> };");
    expect(text).toMatch(
      /local_remove: \{ args: \{ path: string; force: (undefined \| boolean|boolean \| undefined) \}; result: unknown \};/
    );
  });

  it("turns a type its module does not export into unknown", () => {
    const { text } = commandsOf({
      "src/services/api.ts": `
        import { invoke } from "@tauri-apps/api/core";
        interface Hidden { secret: string }
        export const peek = () => invoke<Hidden>("peek_hidden");
      `,
    });
    expect(text).toContain("peek_hidden: { args: undefined; result: unknown };");
  });

  it("joins the types of a command invoked from two places", () => {
    const { text } = commandsOf({
      "src/a.ts": `import { invoke } from "@tauri-apps/api/core";
        export const a = () => invoke<string>("shared_cmd", { id: "x" });`,
      "src/b.ts": `import { invoke } from "@tauri-apps/api/core";
        export const b = () => invoke<number>("shared_cmd", { id: "y", n: 2 });`,
    });
    expect(text).toMatch(
      /shared_cmd: \{ args: \{ id: string \} \| \{ id: string; n: number \}; result: string \| number \};/
    );
  });

  it("skips test files", () => {
    const root = fixture({
      "src/a.ts": `import { invoke } from "@tauri-apps/api/core"; export const a = () => invoke<string>("real_cmd");`,
      "src/a.test.ts": `import { invoke } from "@tauri-apps/api/core"; void invoke<string>("test_only_cmd");`,
    });
    roots.push(root);
    expect(invokeFiles(root).map((f) => path.basename(f))).toEqual(["a.ts"]);
    expect([...collectCommands(root).commands.keys()]).toEqual(["real_cmd"]);
  });

  it("the checked-in file is up to date", async () => {
    const current = readFileSync(path.join(REPO_ROOT, OUTPUT), "utf8");
    expect(current, `run: node scripts/internal/gen-command-types.mjs`).toBe(
      await generate(REPO_ROOT)
    );
  }, 60000);
});

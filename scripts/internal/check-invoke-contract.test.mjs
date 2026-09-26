import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import {
  toCamelCase,
  classifyType,
  stripRustComments,
  parseRustCommands,
  parseRegisteredCommands,
  modulePathOf,
  buildContract,
  collectInvokeCalls,
  findMismatches,
  isProductionTsFile,
  checkRepo,
} from "./check-invoke-contract.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const PLUGIN_RS = `
use tauri::{AppHandle, State};

/// Enable the plugin with the given id.
#[tauri::command]
pub fn enable_plugin(
    id: String,
    app: AppHandle,
    manager: State<'_, PluginManager>,
) -> Result<InstalledPlugin, String> {
    todo!()
}

#[tauri::command]
pub async fn revoke_trusted_publisher(
    key_id: String,
    note: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Foo>,
) -> Result<(), String> {
    Ok(())
}

// #[tauri::command]
// pub fn commented_out(x: String) {}

#[tauri::command(rename_all = "snake_case")]
pub fn snake_cmd(sub_id: u32) {}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn generic_cmd<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    mut buffer_size: usize,
    map: HashMap<String, Vec<(u8, u8)>>,
    on_event: Channel<Frame>,
) {}
`;

const LIB_RS = `
fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            // Plugins
            commands::plugin::enable_plugin,
            commands::plugin::revoke_trusted_publisher,
            commands::plugin::snake_cmd,
            #[cfg(feature = "test-bridge")]
            commands::plugin::generic_cmd,
        ])
        .run(ctx);
}
`;

describe("toCamelCase", () => {
  it("mirrors Tauri's default lowerCamelCase conversion", () => {
    expect(toCamelCase("id")).toBe("id");
    expect(toCamelCase("key_id")).toBe("keyId");
    expect(toCamelCase("session_id_list")).toBe("sessionIdList");
    expect(toCamelCase("x11_display")).toBe("x11Display");
    expect(toCamelCase("_unused")).toBe("unused");
    expect(toCamelCase("r#type")).toBe("type");
  });
});

describe("classifyType", () => {
  it("skips Tauri-injected parameters", () => {
    expect(classifyType("State<'_, Foo>")).toBe("injected");
    expect(classifyType("tauri::State<'_, Foo>")).toBe("injected");
    expect(classifyType("AppHandle")).toBe("injected");
    expect(classifyType("tauri::AppHandle<R>")).toBe("injected");
    expect(classifyType("tauri::WebviewWindow")).toBe("injected");
    expect(classifyType("Window")).toBe("injected");
  });

  it("treats Option<T> as optional and everything else (incl. Channel) as required", () => {
    expect(classifyType("Option<String>")).toBe("optional");
    expect(classifyType("std::option::Option<u32>")).toBe("optional");
    expect(classifyType("String")).toBe("required");
    expect(classifyType("Channel<Frame>")).toBe("required");
    expect(classifyType("Vec<Option<String>>")).toBe("required");
  });
});

describe("stripRustComments", () => {
  it("blanks comments and string contents but keeps offsets", () => {
    const src = 'a // x\nb /* y /* z */ */ c "q\\"(" d \'"\' r#"e"(f"#';
    const out = stripRustComments(src);
    expect(out).toHaveLength(src.length);
    expect(out).not.toMatch(/[xyzqef(]/);
    expect(out).toMatch(/a[\s\S]*b[\s\S]*c[\s\S]*d/);
  });
});

describe("parseRustCommands", () => {
  const cmds = parseRustCommands(PLUGIN_RS);
  const byName = Object.fromEntries(cmds.map((c) => [c.name, c]));

  it("finds every #[tauri::command] fn and ignores commented-out ones", () => {
    expect(cmds.map((c) => c.name)).toEqual([
      "enable_plugin",
      "revoke_trusted_publisher",
      "snake_cmd",
      "generic_cmd",
    ]);
  });

  it("drops injected params and camelCases the rest", () => {
    expect(byName.enable_plugin.params).toEqual([{ rust: "id", key: "id", kind: "required" }]);
    expect(byName.revoke_trusted_publisher.params).toEqual([
      { rust: "key_id", key: "keyId", kind: "required" },
      { rust: "note", key: "note", kind: "optional" },
    ]);
  });

  it("honours rename_all = snake_case", () => {
    expect(byName.snake_cmd.params).toEqual([{ rust: "sub_id", key: "sub_id", kind: "required" }]);
  });

  it("handles generics, extra attributes, `mut` bindings and nested types", () => {
    expect(byName.generic_cmd.params.map((p) => p.key)).toEqual(["bufferSize", "map", "onEvent"]);
  });
});

describe("parseRegisteredCommands / modulePathOf / buildContract", () => {
  it("lists generate_handler! paths including cfg-gated ones", () => {
    expect(parseRegisteredCommands(LIB_RS)).toEqual([
      "commands::plugin::enable_plugin",
      "commands::plugin::revoke_trusted_publisher",
      "commands::plugin::snake_cmd",
      "commands::plugin::generic_cmd",
    ]);
  });

  it("derives module paths from file paths", () => {
    expect(modulePathOf("commands/plugin.rs")).toBe("commands::plugin");
    expect(modulePathOf("commands/agent/mod.rs")).toBe("commands::agent");
    expect(modulePathOf("commands\\files.rs")).toBe("commands::files");
  });

  it("keeps only registered commands and reports unresolvable registrations", () => {
    const { contract, problems } = buildContract(
      { "commands/plugin.rs": PLUGIN_RS, "commands/other.rs": "#[tauri::command]\nfn unreg() {}" },
      LIB_RS.replace("generic_cmd,", "generic_cmd,\ncommands::gone::missing_cmd,")
    );
    expect([...contract.keys()].sort()).toEqual([
      "enable_plugin",
      "generic_cmd",
      "revoke_trusted_publisher",
      "snake_cmd",
    ]);
    expect(problems).toEqual([
      "registered command 'commands::gone::missing_cmd' has no parseable #[tauri::command] fn",
    ]);
  });
});

describe("collectInvokeCalls", () => {
  it("collects literal commands and object-literal keys from the core invoke only", () => {
    const src = `
      import { invoke as tauriInvoke } from "@tauri-apps/api/core";
      import { invoke as other } from "somewhere-else";
      const shared = { id: 1 };
      export async function f(id: string, rest: object) {
        await tauriInvoke<void>("enable_plugin", { id });
        await tauriInvoke("list_plugins");
        await tauriInvoke("x", { "quoted": 1, plain: 2 } as Args);
        await tauriInvoke("y", { a: 1, ...rest });
        await tauriInvoke("z", shared);
        await other("ignored", { nope: 1 });
      }`;
    const calls = collectInvokeCalls(src, "src/a.ts");
    expect(calls.map((c) => [c.command, c.keys, c.open])).toEqual([
      ["enable_plugin", ["id"], false],
      ["list_plugins", [], false],
      ["x", ["quoted", "plain"], false],
      ["y", ["a"], true],
      ["z", ["id"], false],
    ]);
    expect(calls[0].line).toBe(6);
  });

  it("flags calls it cannot verify", () => {
    const src = `
      import { invoke } from "@tauri-apps/api/core";
      export const g = (cmd: string, args: Record<string, unknown>) => invoke(cmd, args);`;
    const [call] = collectInvokeCalls(src, "src/b.tsx");
    expect(call.command).toBeNull();
    expect(call.keys).toBeNull();
  });

  it("ignores files that do not import invoke from @tauri-apps/api/core", () => {
    expect(collectInvokeCalls(`invoke("a", { b: 1 });`, "src/c.ts")).toEqual([]);
  });
});

describe("findMismatches", () => {
  const { contract } = buildContract({ "commands/plugin.rs": PLUGIN_RS }, LIB_RS);
  const call = (command, keys, open = false) => ({
    file: "src/x.ts",
    line: 1,
    command,
    keys,
    open,
  });

  it("accepts correct calls, including omitted optional args", () => {
    expect(
      findMismatches(contract, [
        call("enable_plugin", ["id"]),
        call("revoke_trusted_publisher", ["keyId"]),
        call("revoke_trusted_publisher", ["keyId", "note"]),
        call("snake_cmd", ["sub_id"]),
      ])
    ).toEqual([]);
  });

  it("catches the #3488 shape: wrong key name (unknown extra + missing required)", () => {
    expect(findMismatches(contract, [call("enable_plugin", ["pluginId"])])).toEqual([
      "src/x.ts:1: invoke(\"enable_plugin\") passes unknown arg 'pluginId' (expects: id)",
      "src/x.ts:1: invoke(\"enable_plugin\") is missing required arg 'id' (Rust 'id')",
    ]);
  });

  it("catches snake_case keys sent to a camelCase command", () => {
    const problems = findMismatches(contract, [call("revoke_trusted_publisher", ["key_id"])]);
    expect(problems).toHaveLength(2);
  });

  it("catches unknown command names and unverifiable calls", () => {
    expect(findMismatches(contract, [call("no_such_cmd", [])])[0]).toMatch(
      /no such registered Tauri command/
    );
    expect(
      findMismatches(contract, [
        { ...call(null, null), reason: "command name is not a string literal" },
      ])[0]
    ).toMatch(/cannot verify/);
  });

  it("skips the missing-arg check (but not the unknown-arg check) for spread args", () => {
    expect(findMismatches(contract, [call("enable_plugin", [], true)])).toEqual([]);
    expect(findMismatches(contract, [call("enable_plugin", ["bogus"], true)])).toHaveLength(1);
  });
});

describe("isProductionTsFile", () => {
  it("excludes tests, test setup and declaration files", () => {
    expect(isProductionTsFile("src/services/api.ts")).toBe(true);
    expect(isProductionTsFile("src/components/X.tsx")).toBe(true);
    expect(isProductionTsFile("src/services/api.test.ts")).toBe(false);
    expect(isProductionTsFile("src/components/X.test.tsx")).toBe(false);
    expect(isProductionTsFile("src/test/setup.ts")).toBe(false);
    expect(isProductionTsFile("src/vite-env.d.ts")).toBe(false);
    expect(isProductionTsFile("src/styles.css")).toBe(false);
  });
});

describe("whole repository", () => {
  it("every invoke call in src/ matches its registered Tauri command", () => {
    const { contract, calls, problems } = checkRepo(REPO_ROOT);
    expect(problems).toEqual([]);
    // Sanity: the scan actually found the app's IPC surface.
    expect(contract.size).toBeGreaterThan(100);
    expect(calls.length).toBeGreaterThan(100);
    expect(contract.get("enable_plugin").params.map((p) => p.key)).toEqual(["id"]);
  });
});

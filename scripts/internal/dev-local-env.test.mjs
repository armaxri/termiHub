// Sources scripts/internal/dev-local-env.sh under bash AND zsh against a temp
// dev.local.json and pins the resolved environment (#5144). zsh used to abort on
// bash-only `${!var}` indirection after setting the offset/project but before any
// port, silently leaving dev0's ports in place — the collision dev.local.json
// exists to prevent. The zsh cases skip where zsh is not installed.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "internal", "dev-local-env.sh");

/** Every `_thdl_port VAR base` line of the resolver. */
const BASES = Object.fromEntries(
  [...readFileSync(SCRIPT, "utf8").matchAll(/^_thdl_port (\w+)\s+(\d+)/gm)].map((m) => [
    m[1],
    Number(m[2]),
  ]),
);

const hasShell = (shell) => spawnSync(shell, ["-c", "exit 0"], { stdio: "ignore" }).status === 0;

/**
 * The shells under test. `zsh -f` skips the user's rc files; bash -c reads none
 * (BASH_ENV is stripped below). Windows runs the resolver through Git Bash only,
 * whose path handling makes this harness unreliable, so it is skipped there.
 */
const SHELLS = [
  { name: "bash", argv: ["bash", "-c"], available: process.platform !== "win32" && hasShell("bash") },
  { name: "zsh", argv: ["zsh", "-f", "-c"], available: process.platform !== "win32" && hasShell("zsh") },
];

/** A clean env: nothing the resolver reads may leak in from the test runner. */
function baseEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("TERMIHUB_") || k === "COMPOSE_PROJECT_NAME" || k === "BASH_ENV") continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

/**
 * Source the resolver from `cwd` under `shell` and return the exported env plus
 * the names of any `_thdl_*` helpers (variables or functions) left behind.
 */
function source(shell, cwd, extraEnv) {
  const probe = [
    'source "$1" || exit 97',
    "env",
    "echo __THDL_LEFTOVERS__",
    // `typeset -f`/`declare -F` differ per shell; `type` works in both.
    "for n in _thdl_read _thdl_port; do type \"$n\" >/dev/null 2>&1 && echo \"fn:$n\"; done",
    "set | grep -E '^_thdl_[a-z_]+=' || true",
  ].join("\n");
  const res = spawnSync(shell.argv[0], [...shell.argv.slice(1), probe, "probe", SCRIPT], {
    cwd,
    env: baseEnv(extraEnv),
    encoding: "utf8",
  });
  expect(res.stderr, `${shell.name} wrote to stderr`).toBe("");
  expect(res.status, `${shell.name} failed to source the resolver`).toBe(0);
  const [envPart, leftoverPart] = res.stdout.split("__THDL_LEFTOVERS__\n");
  const env = {};
  for (const line of envPart.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { env, leftovers: leftoverPart.split("\n").filter(Boolean) };
}

/** The values a checkout with this offset/project must resolve to. */
function expected(offset, project) {
  const slot = Math.floor(offset / 1000);
  const want = {
    TERMIHUB_TEST_PORT_OFFSET: String(offset),
    TERMIHUB_TEST_PROJECT: project,
    COMPOSE_PROJECT_NAME: project,
    TERMIHUB_SERIAL_A: `/tmp/termihub-serial-a-${project}`,
    TERMIHUB_SERIAL_B: `/tmp/termihub-serial-b-${project}`,
    TERMIHUB_TEST_TRACE_NET_A: `10.231.${slot * 3}`,
    TERMIHUB_TEST_TRACE_NET_B: `10.231.${slot * 3 + 1}`,
    TERMIHUB_TEST_TRACE_NET_C: `10.231.${slot * 3 + 2}`,
    TERMIHUB_TAURI_DRIVER_PORT: String(4444 + offset),
  };
  for (const [name, base] of Object.entries(BASES)) want[name] = String(base + offset);
  return want;
}

/** The subset of `env` the resolver owns. */
const resolved = (env) =>
  Object.fromEntries(Object.keys(expected(0, "x")).map((k) => [k, env[k]]));

let tmp;

/** A fresh git repo (the resolver locates dev.local.json via the toplevel). */
function checkout(name, devLocal) {
  const dir = path.join(tmp, name);
  execFileSync("git", ["init", "-q", dir]);
  if (devLocal !== undefined) {
    writeFileSync(
      path.join(dir, "dev.local.json"),
      typeof devLocal === "string" ? devLocal : JSON.stringify(devLocal, null, 2),
    );
  }
  return dir;
}

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "thdl-"));
});
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("dev-local-env.sh resolver base ports", () => {
  it("parses the _thdl_port table", () => {
    expect(BASES.TERMIHUB_TEST_RDP_PORT).toBe(2601);
    expect(Object.keys(BASES).length).toBeGreaterThan(30);
  });
});

describe.each(SHELLS)("dev-local-env.sh sourced from $name", (shell) => {
  const test = shell.available ? it : it.skip;

  test("resolves every port, the project and derived values from dev.local.json", () => {
    const dir = checkout(`${shell.name}-slot7`, {
      dev_name: "dev7",
      compose_project: "termihub-test-7",
      test_port_offset: 7000,
    });
    const { env, leftovers } = source(shell, dir);
    expect(resolved(env)).toEqual(expected(7000, "termihub-test-7"));
    expect(leftovers).toEqual([]);
  });

  test("resolves from a subdirectory of the checkout", () => {
    const dir = checkout(`${shell.name}-subdir`, {
      compose_project: "termihub-test-3",
      test_port_offset: 3000,
    });
    const sub = path.join(dir, "nested");
    execFileSync("mkdir", ["-p", sub]);
    expect(resolved(source(shell, sub).env)).toEqual(expected(3000, "termihub-test-3"));
  });

  test("falls back to the single-checkout defaults without dev.local.json", () => {
    const dir = checkout(`${shell.name}-nofile`);
    expect(resolved(source(shell, dir).env)).toEqual(expected(0, "termihub"));
  });

  test("treats a non-numeric offset as 0", () => {
    const dir = checkout(`${shell.name}-badoff`, '{ "test_port_offset": "abc" }');
    expect(resolved(source(shell, dir).env)).toEqual(expected(0, "termihub"));
  });

  test("lets an already-set environment variable win over the file", () => {
    const dir = checkout(`${shell.name}-override`, {
      compose_project: "termihub-test-5",
      test_port_offset: 5000,
    });
    const { env } = source(shell, dir, { TERMIHUB_TEST_RDP_PORT: "12345" });
    expect(env.TERMIHUB_TEST_RDP_PORT).toBe("12345");
    expect(env.TERMIHUB_TEST_RDP_NLA_PORT).toBe(String(2602 + 5000));
  });
});

describe("dev-local-env.sh bash/zsh parity", () => {
  const both = SHELLS.every((s) => s.available);
  (both ? it : it.skip)("sets identical values in bash and zsh", () => {
    const dir = checkout("parity", { compose_project: "termihub-test-9", test_port_offset: 9000 });
    const [bash, zsh] = SHELLS.map((s) => resolved(source(s, dir).env));
    expect(zsh).toEqual(bash);
  });
});

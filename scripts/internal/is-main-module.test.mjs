import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { isMainModule } from "./is-main-module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const noRealpath = () => {
  throw new Error("realpath not expected");
};
const identity = (p) => p;

describe("isMainModule (POSIX paths)", () => {
  const url = "file:///repo/scripts/internal/x.mjs";
  const posix = (argv1, extra = {}) =>
    isMainModule(url, { argv1, platform: "linux", realpath: noRealpath, ...extra });

  it("matches the absolute entry path", () => {
    expect(posix("/repo/scripts/internal/x.mjs")).toBe(true);
  });

  it("matches a non-normalised path to the same file", () => {
    expect(posix("/repo/scripts/../scripts/internal/./x.mjs")).toBe(true);
  });

  it("does not match a different script", () => {
    expect(
      isMainModule(url, {
        argv1: "/repo/scripts/internal/y.mjs",
        platform: "linux",
        realpath: identity,
      })
    ).toBe(false);
  });

  it("is case-sensitive on POSIX", () => {
    expect(
      isMainModule(url, {
        argv1: "/REPO/scripts/internal/x.mjs",
        platform: "linux",
        realpath: identity,
      })
    ).toBe(false);
  });

  it("returns false without argv[1] (REPL / node -e)", () => {
    expect(isMainModule(url, { argv1: undefined, platform: "linux" })).toBe(false);
    expect(isMainModule(url, { argv1: "", platform: "linux" })).toBe(false);
  });

  it("returns false for a non-file URL", () => {
    expect(isMainModule("data:text/javascript,1", { argv1: "/x.mjs", platform: "linux" })).toBe(
      false
    );
  });

  it("falls back to realpath for a symlinked entry", () => {
    const realpath = (p) => p.replace(/^\/var\//, "/private/var/");
    expect(
      isMainModule("file:///private/var/repo/x.mjs", {
        argv1: "/var/repo/x.mjs",
        platform: "darwin",
        realpath,
      })
    ).toBe(true);
  });

  it("returns false when realpath throws (missing file)", () => {
    expect(
      isMainModule(url, { argv1: "/elsewhere/x.mjs", platform: "linux", realpath: noRealpath })
    ).toBe(false);
  });
});

describe("isMainModule (Windows paths)", () => {
  const url = "file:///D:/a/termiHub/termiHub/scripts/internal/x.mjs";
  const win = (argv1) => isMainModule(url, { argv1, platform: "win32", realpath: identity });

  it("matches a backslash drive-letter path (the #3840 bug)", () => {
    // The old `file://${argv[1]}` form built "file://D:\\a\\..." here and never matched.
    const argv1 = "D:\\a\\termiHub\\termiHub\\scripts\\internal\\x.mjs";
    expect(`file://${argv1}`).not.toBe(url);
    expect(win(argv1)).toBe(true);
  });

  it("matches regardless of drive-letter and name case", () => {
    expect(win("d:\\A\\TERMIHUB\\termihub\\Scripts\\internal\\X.mjs")).toBe(true);
  });

  it("matches forward slashes and redundant segments", () => {
    expect(win("D:/a/termiHub/termiHub/scripts/internal/../internal/x.mjs")).toBe(true);
  });

  it("does not match the same path on another drive", () => {
    expect(win("C:\\a\\termiHub\\termiHub\\scripts\\internal\\x.mjs")).toBe(false);
  });

  it("does not match a different script", () => {
    expect(win("D:\\a\\termiHub\\termiHub\\scripts\\internal\\y.mjs")).toBe(false);
  });

  it("handles percent-encoded characters in the module URL", () => {
    expect(
      isMainModule("file:///C:/Users/John%20Doe/repo/x.mjs", {
        argv1: "C:\\Users\\John Doe\\repo\\x.mjs",
        platform: "win32",
        realpath: identity,
      })
    ).toBe(true);
  });

  it("matches a UNC path", () => {
    expect(
      isMainModule("file://server/share/repo/x.mjs", {
        argv1: "\\\\server\\share\\repo\\x.mjs",
        platform: "win32",
        realpath: identity,
      })
    ).toBe(true);
  });
});

describe("isMainModule (real node processes)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "is-main-module-"));
  const helperUrl = pathToFileURL(path.join(HERE, "is-main-module.mjs")).href;
  const entry = path.join(dir, "entry.mjs");
  const lib = path.join(dir, "lib.mjs");
  writeFileSync(
    lib,
    `import { isMainModule } from ${JSON.stringify(helperUrl)};\n` +
      `export const libIsMain = isMainModule(import.meta.url);\n`
  );
  writeFileSync(
    entry,
    `import { isMainModule } from ${JSON.stringify(helperUrl)};\n` +
      `import { libIsMain } from "./lib.mjs";\n` +
      `process.stdout.write(JSON.stringify({ entry: isMainModule(import.meta.url), lib: libIsMain }));\n`
  );
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args, cwd) =>
    JSON.parse(execFileSync(process.execPath, args, { cwd, encoding: "utf8" }));

  it("is true for the entry script and false for an imported module (absolute path)", () => {
    expect(run([entry], dir)).toEqual({ entry: true, lib: false });
  });

  it("is true when started with a relative path", () => {
    expect(run(["./entry.mjs"], dir)).toEqual({ entry: true, lib: false });
  });

  it.skipIf(process.platform === "win32")("is true when started through a symlink", () => {
    const link = path.join(dir, "link.mjs");
    symlinkSync(entry, link);
    expect(run([link], dir).entry).toBe(true);
  });
});

describe("scripts use the shared entry-point check", () => {
  const repoRoot = path.resolve(HERE, "..", "..");
  const tracked = execFileSync("git", ["ls-files", "--", "scripts/*.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => f && !f.endsWith(".test.mjs") && !f.endsWith("/is-main-module.mjs"));

  it("finds the scripts to check", () => {
    expect(tracked.length).toBeGreaterThan(10);
  });

  it("no script hand-rolls an import.meta.url vs process.argv[1] comparison (#3840)", () => {
    const offenders = tracked.filter((f) => {
      const text = readFileSync(path.join(repoRoot, f), "utf8");
      return text
        .split("\n")
        .some((line) => line.includes("import.meta.url") && line.includes("process.argv[1]"));
    });
    expect(offenders).toEqual([]);
  });
});

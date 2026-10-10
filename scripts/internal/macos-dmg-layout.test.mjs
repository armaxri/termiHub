// Guards for keeping Tauri's DMG layout through the macOS re-sign (PKG2-009,
// #4361).
//
// release.yml and dev-build.yml re-sign the .app ad-hoc and used to rebuild
// the DMG with `hdiutil create -srcfolder <app>`, which dropped Tauri's
// /Applications drop link (drag-to-install), volume icon and layout. Now
// macos-dmg-layout.sh swaps the re-signed app into Tauri's own image. These
// tests pin:
//   - both workflows call `replace-app` + `check` and no longer rebuild the
//     image from the bare app; the macOS install smoke runs `check`;
//   - the helper, executed against a stub `hdiutil` (an image is a tar file),
//     keeps every other volume entry, adds a missing Applications link,
//     leaves the original image untouched on any failure and never leaves a
//     volume attached;
//   - on macOS with TERMIHUB_REAL_HDIUTIL=1, the same round trip on a real
//     tiny DMG.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts/internal/macos-dmg-layout.sh");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

/** The `run:` block of the named step in a workflow. */
function stepBody(text, name) {
  const start = text.indexOf(`- name: ${name}\n`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.search(/\n\s+- name: /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe.each([".github/workflows/release.yml", ".github/workflows/dev-build.yml"])(
  "%s keeps the DMG layout when re-signing (#4361)",
  (file) => {
    const body = stepBody(read(file), "Re-sign macOS DMG with consistent ad-hoc signature");

    it("swaps the re-signed app into Tauri's image and checks the layout", () => {
      const replace = body.indexOf(
        'scripts/internal/macos-dmg-layout.sh replace-app "$DMG" "$APP"'
      );
      const check = body.indexOf('scripts/internal/macos-dmg-layout.sh check "$DMG"');
      const verify = body.indexOf("codesign --verify --deep --strict");
      expect(verify).toBeGreaterThan(-1);
      expect(replace).toBeGreaterThan(verify);
      expect(check).toBeGreaterThan(replace);
    });

    it("no longer rebuilds the image from the bare app", () => {
      expect(body).not.toMatch(/hdiutil create\b/);
      expect(body).not.toMatch(/rm "\$DMG"/);
    });
  }
);

describe("release-macos-smoke.yml checks the DMG layout (#4361)", () => {
  it("runs macos-dmg-layout.sh check on the downloaded DMG", () => {
    const text = read(".github/workflows/release-macos-smoke.yml");
    const body = stepBody(text, "Check the DMG keeps the drag-to-install layout");
    expect(body).toContain('scripts/internal/macos-dmg-layout.sh check "$DMG"');
    expect(body).not.toMatch(/continue-on-error|\|\| true/);
    expect(text).toMatch(/sparse-checkout: scripts\/internal/);
  });
});

// The helper is bash; skip spawning bash on Windows (Git-Bash-on-PATH flake).
const describeUnix = process.platform === "win32" ? describe.skip : describe;

/**
 * A fake `hdiutil` whose "images" are tar files. attach extracts into the
 * mount point and records it in $HD_STATE/mounts; detach writes a writable
 * mount back into its image. $HD_FAIL names an operation to fail:
 * convert-udzo | attach-rw | detach.
 */
const STUB_HDIUTIL = `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$HD_LOG"
op="$1"; shift
case "$op" in
  convert)
    src="$1"; fmt=""; out=""
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in -format) fmt="$2"; shift 2 ;; -o) out="$2"; shift 2 ;; *) shift ;; esac
    done
    [ "$HD_FAIL" = "convert-$(echo "$fmt" | tr 'A-Z' 'a-z')" ] && exit 1
    cp "$src" "$out" ;;
  resize)
    if [ "$1" = -limits ]; then echo "100 2048 999999"; else echo "$*" >> "$HD_STATE/resized"; fi ;;
  attach)
    img="$1"; shift; mount=""; mode=rw
    while [ "$#" -gt 0 ]; do
      case "$1" in -mountpoint) mount="$2"; shift 2 ;; -readonly) mode=ro; shift ;; *) shift ;; esac
    done
    [ "$HD_FAIL" = "attach-$mode" ] && exit 1
    mkdir -p "$mount"
    tar -xf "$img" -C "$mount"
    echo "$mount|$img|$mode" >> "$HD_STATE/mounts" ;;
  detach)
    mount="$1"
    [ "$HD_FAIL" = detach ] && exit 1
    line="$(grep -F "$mount|" "$HD_STATE/mounts" | head -n 1)"
    [ -n "$line" ] || { echo "not attached: $mount" >&2; exit 1; }
    img="$(echo "$line" | cut -d'|' -f2)"; mode="$(echo "$line" | cut -d'|' -f3)"
    [ "$mode" = rw ] && tar -cf "$img" -C "$mount" .
    rm -rf "$mount"
    grep -vF "$mount|" "$HD_STATE/mounts" > "$HD_STATE/mounts.new" || true
    mv "$HD_STATE/mounts.new" "$HD_STATE/mounts" ;;
  *) echo "stub hdiutil: unhandled $op" >&2; exit 3 ;;
esac
`;

const STUB_DITTO = `#!/usr/bin/env bash
cp -R "$1" "$2"
`;

describeUnix("macos-dmg-layout.sh (executed, stub hdiutil)", () => {
  let dir;
  let bin;
  let state;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "macos-dmg-layout-"));
    bin = path.join(dir, "bin");
    state = path.join(dir, "state");
    mkdirSync(bin);
    mkdirSync(state);
    writeFileSync(path.join(state, "mounts"), "");
    writeFileSync(path.join(bin, "hdiutil"), STUB_HDIUTIL);
    writeFileSync(path.join(bin, "ditto"), STUB_DITTO);
    chmodSync(path.join(bin, "hdiutil"), 0o755);
    chmodSync(path.join(bin, "ditto"), 0o755);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A tar "image" holding the given volume layout. */
  function makeImage(name, { link = "/Applications", apps = ["termiHub.app"] } = {}) {
    const vol = path.join(dir, `${name}-vol`);
    for (const app of apps) {
      mkdirSync(path.join(vol, app, "Contents", "MacOS"), { recursive: true });
      writeFileSync(path.join(vol, app, "Contents", "MacOS", "termiHub"), "tauri-signed");
    }
    mkdirSync(vol, { recursive: true });
    writeFileSync(path.join(vol, ".VolumeIcon.icns"), "icon");
    writeFileSync(path.join(vol, ".DS_Store"), "layout");
    if (link !== null) symlinkSync(link, path.join(vol, "Applications"));
    const image = path.join(dir, `${name}.dmg`);
    const r = spawnSync("tar", ["-cf", image, "-C", vol, "."]);
    expect(r.status).toBe(0);
    return image;
  }

  /** A re-signed app bundle named `name`. */
  function makeApp(name = "termiHub.app") {
    const app = path.join(dir, "signed", name);
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    writeFileSync(path.join(app, "Contents", "MacOS", "termiHub"), "re-signed");
    return app;
  }

  /** Extract a tar image to inspect it. */
  function unpack(image) {
    const out = mkdtempSync(path.join(dir, "inspect-"));
    expect(spawnSync("tar", ["-xf", image, "-C", out]).status).toBe(0);
    return out;
  }

  function run(args, env = {}) {
    return spawnSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HD_LOG: path.join(dir, "hdiutil.log"),
        HD_STATE: state,
        HD_FAIL: "",
        ...env,
      },
    });
  }

  const mounted = () => readFileSync(path.join(state, "mounts"), "utf8").trim();

  it("--help exits 0", () => {
    expect(run(["--help"]).status).toBe(0);
  });

  it("replace-app keeps the Applications link and every other volume entry", () => {
    const image = makeImage("tauri");
    const r = run(["replace-app", image, makeApp()]);
    expect(r.status, r.stderr).toBe(0);
    const vol = unpack(image);
    expect(readFileSync(path.join(vol, "termiHub.app/Contents/MacOS/termiHub"), "utf8")).toBe(
      "re-signed"
    );
    expect(lstatSync(path.join(vol, "Applications")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(vol, "Applications"))).toBe("/Applications");
    expect(readFileSync(path.join(vol, ".VolumeIcon.icns"), "utf8")).toBe("icon");
    expect(readFileSync(path.join(vol, ".DS_Store"), "utf8")).toBe("layout");
    expect(mounted()).toBe("");
    // The writable copy was grown and compressed back to UDZO.
    const log = readFileSync(path.join(dir, "hdiutil.log"), "utf8");
    expect(log).toMatch(/-format UDRW/);
    expect(log).toMatch(/resize -sectors \d+/);
    expect(log).toMatch(/-format UDZO/);
    expect(run(["check", image]).status).toBe(0);
  });

  it("replace-app adds an Applications link to an image that lacks one", () => {
    const image = makeImage("bare", { link: null });
    expect(run(["check", image]).status).toBe(1);
    const r = run(["replace-app", image, makeApp()]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("::warning::");
    expect(readlinkSync(path.join(unpack(image), "Applications"))).toBe("/Applications");
  });

  it("replace-app refuses a differently named app and leaves the image untouched", () => {
    const image = makeImage("tauri");
    const before = readFileSync(image);
    const r = run(["replace-app", image, makeApp("Other.app")]);
    expect(r.status).toBe(1);
    expect(readFileSync(image).equals(before)).toBe(true);
    expect(mounted()).toBe("");
  });

  it("replace-app refuses an image holding two apps", () => {
    const image = makeImage("two", { apps: ["termiHub.app", "Extra.app"] });
    const before = readFileSync(image);
    expect(run(["replace-app", image, makeApp()]).status).toBe(1);
    expect(readFileSync(image).equals(before)).toBe(true);
  });

  it("replace-app leaves the image untouched when compressing fails", () => {
    const image = makeImage("tauri");
    const before = readFileSync(image);
    const r = run(["replace-app", image, makeApp()], { HD_FAIL: "convert-udzo" });
    expect(r.status).not.toBe(0);
    expect(readFileSync(image).equals(before)).toBe(true);
    expect(mounted()).toBe("");
  });

  it("replace-app leaves the image untouched when the writable copy cannot attach", () => {
    const image = makeImage("tauri");
    const before = readFileSync(image);
    expect(run(["replace-app", image, makeApp()], { HD_FAIL: "attach-rw" }).status).not.toBe(0);
    expect(readFileSync(image).equals(before)).toBe(true);
  });

  it("replace-app rejects a missing image or a non-.app bundle", () => {
    expect(run(["replace-app", path.join(dir, "none.dmg"), makeApp()]).status).toBe(1);
    const image = makeImage("tauri");
    const notApp = path.join(dir, "folder");
    mkdirSync(notApp);
    expect(run(["replace-app", image, notApp]).status).toBe(1);
  });

  it("check fails on a link that does not point to /Applications", () => {
    const image = makeImage("wrong", { link: "/tmp" });
    const r = run(["check", image]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not /Applications");
    expect(mounted()).toBe("");
  });

  it("check fails on an image without an app", () => {
    const image = makeImage("empty", { apps: [] });
    expect(run(["check", image]).status).toBe(1);
  });

  it("an unknown subcommand exits 2", () => {
    expect(run(["frobnicate"]).status).toBe(2);
  });
});

// Real round trip on macOS. Opt-in: hdiutil attaches disk images system-wide,
// which a shared CI runner or a sandbox may not allow.
const describeRealHdiutil =
  process.platform === "darwin" && process.env.TERMIHUB_REAL_HDIUTIL === "1"
    ? describe
    : describe.skip;

describeRealHdiutil("macos-dmg-layout.sh (real hdiutil)", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "macos-dmg-real-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const sh = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    expect(r.status, `${cmd} ${args.join(" ")}\n${r.stderr}`).toBe(0);
    return r.stdout;
  };

  it("swaps the app into a Tauri-like DMG and keeps the Applications link", () => {
    const src = path.join(dir, "src");
    mkdirSync(path.join(src, "termiHub.app", "Contents", "MacOS"), { recursive: true });
    writeFileSync(path.join(src, "termiHub.app", "Contents", "MacOS", "termiHub"), "old");
    symlinkSync("/Applications", path.join(src, "Applications"));
    writeFileSync(path.join(src, ".VolumeIcon.icns"), "icon");
    const dmg = path.join(dir, "t.dmg");
    sh(
      "hdiutil",
      ["create", "-volname", "termiHub", "-fs", "HFS+", "-srcfolder", src].concat([
        "-format",
        "UDZO",
        dmg,
        "-quiet",
      ])
    );

    const app = path.join(dir, "signed", "termiHub.app");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    // Larger than the original image, so the writable copy must grow.
    writeFileSync(path.join(app, "Contents", "MacOS", "termiHub"), Buffer.alloc(4 << 20, 7));

    sh("bash", [SCRIPT, "replace-app", dmg, app]);
    sh("bash", [SCRIPT, "check", dmg]);

    const mount = path.join(dir, "mount");
    sh("hdiutil", ["attach", dmg, "-mountpoint", mount, "-readonly", "-nobrowse", "-quiet"]);
    try {
      expect(readlinkSync(path.join(mount, "Applications"))).toBe("/Applications");
      expect(existsSync(path.join(mount, ".VolumeIcon.icns"))).toBe(true);
      expect(lstatSync(path.join(mount, "termiHub.app/Contents/MacOS/termiHub")).size).toBe(
        4 << 20
      );
    } finally {
      sh("hdiutil", ["detach", mount, "-quiet"]);
    }
    expect(sh("hdiutil", ["imageinfo", dmg])).toMatch(/Format: UDZO/);
  }, 120_000);
});

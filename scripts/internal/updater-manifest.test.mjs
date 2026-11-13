// Tests for the in-app updater manifest writer/checker (#5758).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildManifest,
  configuredPubkey,
  loadPlatforms,
  main,
  manifestProblems,
  parsePublicKey,
  verifySignature,
} from "./updater-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Produced by `pnpm tauri signer sign --app-version 1.2.3` (CLI 2.12.1) with a
// throwaway key that was destroyed afterwards: public material only. It pins
// the verifier to the real Tauri/minisign format, not just our own encoder.
const TAURI_PUBKEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEVFOTI0QkZCQjQ5RjU0NDAKUldSQVZKKzArMHVTN29tbkZNdm5OQ201RTBqNGoyNmZ6cjVKWnZ5MTBiVFVsSUhzd3J5bWNuaE4K";
const TAURI_SIG =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSQVZKKzArMHVTN3UxQ0FZUllXNjVMc3AxM0lLOVFUbkZLbUlLRmhGZndVNkVtczJyQjV1YWlSOHcxUVVRT0IwK3ZtSi9ONloxclA2QklpaVZwNTIwZFRrMHlEcmlTQUFJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0NjExMjk2CWZpbGU6cGF5bG9hZC5iaW4JdmVyc2lvbjoxLjIuMwpzYVpFVEg4VWFKMlUzNGhUVDBHeStTWGRiY3c3MnBCUXhwUjFzcUwwL3NqelNVQTI2cWZoSlNzU2RHYUZqVEJ0OExPK1c5YUwra3Btc2pZWWl5aGJCQT09Cg==";
const TAURI_PAYLOAD = Buffer.from("hello\n");

/** A throwaway minisign key that signs like `tauri signer sign`. */
function makeSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const keyId = randomBytes(8);
  const pubText = `untrusted comment: minisign public key\n${Buffer.concat([
    Buffer.from("Ed"),
    keyId,
    raw,
  ]).toString("base64")}\n`;
  return {
    pubkey: Buffer.from(pubText).toString("base64"),
    sign(data, version) {
      const digest = createHash("blake2b512").update(data).digest();
      const sig = sign(null, digest, privateKey);
      const trusted = `timestamp:1\tfile:x\tversion:${version}`;
      const global = sign(null, Buffer.concat([sig, Buffer.from(trusted)]), privateKey);
      const text =
        "untrusted comment: signature from tauri secret key\n" +
        `${Buffer.concat([Buffer.from("ED"), keyId, sig]).toString("base64")}\n` +
        `trusted comment: ${trusted}\n${global.toString("base64")}\n`;
      return Buffer.from(text).toString("base64");
    },
  };
}

const platforms = loadPlatforms();
const VERSION = "0.2.0";

let dir;
let signer;

/** Stage one bundle + .sig per published target, as build-app does. */
function stage({ version = VERSION, signedVersion = version } = {}) {
  for (const p of platforms.platforms) {
    const asset = p.asset.replaceAll("{version}", version);
    const data = Buffer.from(`bundle for ${p.target}`);
    writeFileSync(path.join(dir, asset), data);
    writeFileSync(path.join(dir, `${asset}.sig`), signer.sign(data, signedVersion));
  }
}

const problemsFor = (manifest, pubkey = signer.pubkey) =>
  manifestProblems({ manifest, version: VERSION, dir, pubkey, platforms });

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "updater-manifest-"));
  signer = makeSigner();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("verifySignature", () => {
  it("accepts a real `tauri signer sign` signature and reads its version", () => {
    const fields = verifySignature(TAURI_SIG, TAURI_PAYLOAD, TAURI_PUBKEY);
    expect(fields.version).toBe("1.2.3");
    expect(fields.file).toBe("payload.bin");
  });

  it("rejects changed bytes", () => {
    expect(() => verifySignature(TAURI_SIG, Buffer.from("hello!\n"), TAURI_PUBKEY)).toThrow(
      /does not match/
    );
  });

  it("rejects a signature from another key", () => {
    const other = makeSigner();
    expect(() => verifySignature(TAURI_SIG, TAURI_PAYLOAD, other.pubkey)).toThrow(
      /different key/
    );
  });

  it("rejects a tampered trusted comment (a re-labelled version)", () => {
    const text = Buffer.from(TAURI_SIG, "base64")
      .toString("utf8")
      .replace("version:1.2.3", "version:9.9.9");
    expect(() =>
      verifySignature(Buffer.from(text).toString("base64"), TAURI_PAYLOAD, TAURI_PUBKEY)
    ).toThrow(/trusted comment/);
  });

  it("rejects malformed keys", () => {
    expect(() => parsePublicKey(Buffer.from("nope").toString("base64"))).toThrow(/not a minisign/);
  });
});

describe("buildManifest + manifestProblems", () => {
  it("writes a manifest that passes the check", () => {
    stage();
    const manifest = buildManifest({ version: VERSION, dir, platforms, pubDate: "2026-11-14T00:00:00Z" });
    expect(Object.keys(manifest.platforms).sort()).toEqual(
      platforms.platforms.map((p) => p.target).sort()
    );
    expect(manifest.platforms["darwin-aarch64-app"].url).toBe(
      "https://github.com/armaxri/termiHub/releases/download/v0.2.0/termiHub-0.2.0-macos-arm64.app.tar.gz"
    );
    expect(problemsFor(manifest)).toEqual([]);
  });

  it("reports a wrong version, a missing target and an unknown one", () => {
    stage();
    const manifest = buildManifest({ version: VERSION, dir, platforms });
    manifest.version = "0.1.9";
    delete manifest.platforms["windows-x86_64-msi"];
    manifest.platforms["linux-aarch64-deb"] = manifest.platforms["linux-x86_64-appimage"];
    const problems = problemsFor(manifest);
    expect(problems).toContain('version is "0.1.9", expected "0.2.0"');
    expect(problems).toContain("windows-x86_64-msi: missing");
    expect(problems).toContain("linux-aarch64-deb: not a published updater target");
  });

  it("reports a url that is not the target's release bundle", () => {
    stage();
    const manifest = buildManifest({ version: VERSION, dir, platforms });
    manifest.platforms["darwin-x86_64-app"].url = manifest.platforms["darwin-aarch64-app"].url;
    expect(problemsFor(manifest).join("\n")).toMatch(/darwin-x86_64-app: url is/);
  });

  it("reports a signature that is not the bundle's .sig", () => {
    stage();
    const manifest = buildManifest({ version: VERSION, dir, platforms });
    manifest.platforms["windows-x86_64-msi"].signature =
      manifest.platforms["linux-x86_64-appimage"].signature;
    expect(problemsFor(manifest)).toContain(
      "windows-x86_64-msi: signature differs from termiHub-0.2.0-windows-x64.msi.sig"
    );
  });

  it("reports bundles signed for another version (a re-labelled old build)", () => {
    stage({ signedVersion: "0.1.0" });
    const manifest = buildManifest({ version: VERSION, dir, platforms });
    expect(problemsFor(manifest).join("\n")).toMatch(/signed for version "0.1.0"/);
  });

  it("checks the signed version separately when the asset version differs (dry run)", () => {
    stage({ signedVersion: "0.1.0" });
    const manifest = buildManifest({ version: VERSION, dir, platforms });
    const problems = manifestProblems({
      manifest,
      version: VERSION,
      dir,
      pubkey: signer.pubkey,
      platforms,
      signedVersion: "0.1.0",
    });
    expect(problems).toEqual([]);
  });

  it("reports signatures made with a key other than the configured one", () => {
    stage();
    const manifest = buildManifest({ version: VERSION, dir, platforms });
    expect(problemsFor(manifest, makeSigner().pubkey).join("\n")).toMatch(/different key/);
  });

  it("refuses to write when a .sig is missing", () => {
    expect(() => buildManifest({ version: VERSION, dir, platforms })).toThrow(/\.sig is not in/);
  });
});

describe("CLI", () => {
  const quiet = () => {
    const lines = [];
    return { lines, log: (l) => lines.push(l), error: (l) => lines.push(l) };
  };

  function configWith(pubkey) {
    const file = path.join(dir, "tauri.updater.conf.json");
    writeFileSync(file, JSON.stringify({ plugins: { updater: { pubkey } } }));
    return file;
  }

  it("writes and checks latest.json end to end", () => {
    stage();
    const out = quiet();
    const config = configWith(signer.pubkey);
    expect(main(["write", "--version", VERSION, "--dir", dir, "--config", config], out)).toBe(0);
    const manifest = JSON.parse(readFileSync(path.join(dir, "latest.json"), "utf8"));
    expect(manifest.version).toBe(VERSION);
    expect(main(["check", "--version", VERSION, "--dir", dir, "--config", config], out)).toBe(0);
  });

  it("fails the check of a tampered bundle", () => {
    stage();
    const config = configWith(signer.pubkey);
    expect(main(["write", "--version", VERSION, "--dir", dir, "--config", config], quiet())).toBe(0);
    writeFileSync(path.join(dir, `termiHub-${VERSION}-linux-x64.AppImage`), "evil");
    const out = quiet();
    expect(main(["check", "--version", VERSION, "--dir", dir, "--config", config], out)).toBe(1);
    expect(out.lines.join("\n")).toMatch(/linux-x86_64-appimage: signature does not match/);
  });

  it("fails without a configured key and on bad arguments", () => {
    const config = configWith("");
    expect(main(["check", "--version", VERSION, "--dir", dir, "--config", config], quiet())).toBe(1);
    expect(main(["check", "--dir", dir], quiet())).toBe(2);
    expect(main(["sign"], quiet())).toBe(2);
  });

  it("prints the configured key (empty until the maintainer sets it up)", () => {
    const out = quiet();
    expect(main(["pubkey", "--config", configWith("abc")], out)).toBe(0);
    expect(out.lines).toEqual(["abc"]);
  });
});

describe("repository wiring", () => {
  it("the release config and the platforms file agree on the endpoint", () => {
    const config = JSON.parse(
      readFileSync(path.join(ROOT, "src-tauri", "tauri.updater.conf.json"), "utf8")
    );
    expect(config.plugins.updater.endpoints).toEqual([platforms.endpoint]);
    expect(typeof configuredPubkey()).toBe("string");
  });

  it("release.yml writes and checks latest.json and uploads it", () => {
    const releaseYml = readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    expect(releaseYml).toContain("scripts/internal/updater-manifest.mjs write");
    expect(releaseYml).toContain("scripts/internal/updater-manifest.mjs check");
    expect(releaseYml).toContain("--config src-tauri/tauri.updater.conf.json");
    expect(releaseYml).toMatch(/gh release upload "v\$\{VERSION\}" --clobber latest\.json/);
  });

  it("only release.yml merges the updater config (no signing on main/develop builds)", () => {
    for (const wf of ["build.yml", "dev-build.yml"]) {
      const text = readFileSync(path.join(ROOT, ".github", "workflows", wf), "utf8");
      expect(text, wf).not.toContain("tauri.updater.conf.json");
    }
  });
});

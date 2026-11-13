// Pins the designated-requirement checks behind termiHub's stable macOS signing
// identity (#5545). The fixtures are real `codesign -d -r-` output captured on
// macOS 27: two DIFFERENT binaries (different code, different signing time)
// signed by one self-signed certificate under one identifier share one DR,
// while an ad-hoc signature's DR is its build hash.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkDesignatedRequirement,
  checkSameRequirement,
  extractDesignatedRequirement,
  normalizeSha1,
  parseRequirement,
  readPinned,
  runCli,
  PIN_FILE,
} from "./macos-signing.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CERT = "2907f0dfe0deca32b6328c02b54418e12773382d";
const OTHER = "0123456789abcdef0123456789abcdef01234567";

// Release N and release N+1 of the app: same identity, different code.
const BUILD_A =
  "Executable=/tmp/a/termiHub.app/Contents/MacOS/termihub\n" +
  `designated => identifier "com.termihub.app" and certificate root = H"${CERT}"\n`;
const BUILD_B =
  "Executable=/tmp/b/termiHub.app/Contents/MacOS/termihub\n" +
  `designated => identifier "com.termihub.app" and certificate root = H"${CERT}"\n`;
const HELPER = `Executable=/tmp/x/termihub-rdp-helper\ndesignated => identifier termihub-rdp-helper and certificate root = H"${CERT}"\n`;
const LEAF = `designated => identifier "com.termihub.app" and certificate leaf = H"${CERT.toUpperCase()}"\n`;
const ADHOC =
  "Executable=/tmp/kcadd-adhoc\n" +
  '# designated => cdhash H"16d27672ff8fa3f47006b47cfa7112450df2fae3"\n';
const APPLE =
  'Executable=/usr/bin/true\ndesignated => identifier "com.apple.true" and anchor apple\n';

describe("extractDesignatedRequirement / parseRequirement", () => {
  it("reads a self-signed certificate DR", () => {
    expect(parseRequirement(extractDesignatedRequirement(BUILD_A))).toEqual({
      kind: "certificate",
      identifier: "com.termihub.app",
      slot: "root",
      certSha1: CERT,
    });
  });

  it("reads an unquoted identifier and a leaf slot", () => {
    expect(parseRequirement(extractDesignatedRequirement(HELPER))).toMatchObject({
      identifier: "termihub-rdp-helper",
      slot: "root",
    });
    expect(parseRequirement(extractDesignatedRequirement(LEAF))).toMatchObject({
      slot: "leaf",
      certSha1: CERT,
    });
  });

  it("recognises the ad-hoc build-hash DR printed as a comment", () => {
    expect(parseRequirement(extractDesignatedRequirement(ADHOC))).toEqual({
      kind: "cdhash",
      cdhash: "16d27672ff8fa3f47006b47cfa7112450df2fae3",
    });
  });

  it("treats any other requirement shape as other", () => {
    expect(parseRequirement(extractDesignatedRequirement(APPLE)).kind).toBe("other");
    expect(
      parseRequirement(`certificate root = H"${CERT}" and certificate leaf[subject.OU] = X`).kind
    ).toBe("other");
  });

  it("returns null when codesign printed no DR", () => {
    expect(extractDesignatedRequirement("code object is not signed at all\n")).toBeNull();
  });
});

describe("checkDesignatedRequirement", () => {
  it("accepts the pinned certificate and identifier", () => {
    expect(
      checkDesignatedRequirement(BUILD_A, { certSha1: CERT, identifier: "com.termihub.app" })
    ).toContain(`H"${CERT}"`);
    expect(() => checkDesignatedRequirement(LEAF, { certSha1: CERT })).not.toThrow();
  });

  it("accepts the SHA-1 in openssl or security notation", () => {
    const colons = CERT.toUpperCase().match(/../g).join(":");
    expect(() =>
      checkDesignatedRequirement(BUILD_A, { certSha1: `sha1 Fingerprint=${colons}` })
    ).not.toThrow();
  });

  it("rejects an ad-hoc signature, naming why it matters", () => {
    expect(() => checkDesignatedRequirement(ADHOC, { certSha1: CERT })).toThrow(/ad-hoc.*keychain/);
  });

  it("rejects another certificate, a wrong identifier and an unsigned binary", () => {
    expect(() => checkDesignatedRequirement(BUILD_A, { certSha1: OTHER })).toThrow(
      /expected the pinned/
    );
    expect(() =>
      checkDesignatedRequirement(HELPER, { certSha1: CERT, identifier: "termihub-plugin-runner" })
    ).toThrow(/signing identifier/);
    expect(() => checkDesignatedRequirement("not signed\n", { certSha1: CERT })).toThrow(
      /unsigned/
    );
    expect(() => checkDesignatedRequirement(APPLE, { certSha1: CERT })).toThrow(/unexpected/);
  });

  it("rejects a malformed pin", () => {
    expect(() => checkDesignatedRequirement(BUILD_A, { certSha1: "abc" })).toThrow(/SHA-1/);
    expect(() => normalizeSha1("")).toThrow();
  });
});

describe("checkSameRequirement (two builds, one identity => one DR)", () => {
  it("passes for two builds signed by the same identity", () => {
    expect(
      checkSameRequirement([
        { label: "release N", output: BUILD_A },
        { label: "release N+1", output: BUILD_B },
      ])
    ).toBe(`identifier "com.termihub.app" and certificate root = H"${CERT}"`);
  });

  it("fails when the certificate changed between builds", () => {
    expect(() =>
      checkSameRequirement([
        { label: "release N", output: BUILD_A },
        { label: "release N+1", output: BUILD_B.replace(CERT, OTHER) },
      ])
    ).toThrow(/differ/);
  });

  it("fails for ad-hoc builds, whose DR is the build hash", () => {
    expect(() =>
      checkSameRequirement([
        { label: "a", output: ADHOC },
        { label: "b", output: ADHOC },
      ])
    ).toThrow(/not certificate-based/);
    expect(() => checkSameRequirement([{ label: "a", output: BUILD_A }])).toThrow(/two/);
  });
});

describe("runCli", () => {
  const fixtures = { a: BUILD_A, b: BUILD_B, helper: HELPER, adhoc: ADHOC };
  const read = (target) => fixtures[target];

  it("check passes and fails like the library", () => {
    expect(
      runCli(["check", "--cert-sha1", CERT, "--identifier", "com.termihub.app", "a", "b"], read)
    ).toMatch(/^ok {2}a: .*\nok {2}b: /);
    expect(() => runCli(["check", "--cert-sha1", CERT, "adhoc"], read)).toThrow(/ad-hoc/);
    expect(() => runCli(["check", "a"], read)).toThrow(/--cert-sha1/);
    expect(() => runCli(["check", "--cert-sha1", CERT], read)).toThrow(/path/);
    expect(() => runCli(["check", "--bogus", "a"], read)).toThrow(/unknown option/);
  });

  it("same compares the DRs", () => {
    expect(runCli(["same", "a", "b"], read)).toContain("2 signatures share");
    expect(() => runCli(["same", "a", "helper"], read)).toThrow(/differ/);
  });

  it("rejects unknown commands", () => {
    expect(() => runCli([], read)).toThrow(/unknown command/);
    expect(() => runCli(["pinned", "x"], read)).toThrow(/no arguments/);
  });
});

describe("pin file", () => {
  it("is valid and either empty or a SHA-1", () => {
    const pinned = readPinned();
    expect(pinned === "" || /^[0-9a-f]{40}$/.test(pinned)).toBe(true);
  });

  it("reads a set pin in any notation", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "macos-pin-"));
    try {
      const file = path.join(dir, "pin.json");
      writeFileSync(file, JSON.stringify({ certificateSha1: CERT.toUpperCase() }));
      expect(readPinned(file)).toBe(CERT);
      writeFileSync(file, JSON.stringify({ certificateSha1: "nope" }));
      expect(() => readPinned(file)).toThrow(/SHA-1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is what release.yml and the setup script read", () => {
    expect(PIN_FILE).toBe(path.join(ROOT, "scripts", "internal", "macos-signing-identity.json"));
    const release = readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8");
    expect(release).toContain("scripts/internal/macos-signing-keychain.sh ci-import");
    expect(release).toContain("node scripts/internal/macos-signing.mjs check");
    const setup = readFileSync(
      path.join(ROOT, "scripts/internal/setup-macos-signing-identity.sh"),
      "utf8"
    );
    expect(setup).toContain("macos-signing.mjs");
    expect(setup).toContain("macos-signing-identity.json");
  });
});

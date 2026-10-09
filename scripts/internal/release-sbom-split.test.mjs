// Structural guard for the release SBOM jobs (SUP2-002, #4280).
//
// The SBOM generators are third-party code, so they must never run next to a
// write, OIDC or attestation token. release.yml splits the work: sbom-generate
// runs the pinned generators with a read-only token and uploads the SBOMs as a
// workflow artifact; sbom downloads that artifact, attests it and uploads it as
// release assets using only first-party, SHA-pinned actions and `gh`. These
// tests pin that split, the exact pin of @cyclonedx/cyclonedx-npm, and that no
// release workflow fetches npm code with `npx` (an unlocked tree that runs
// install scripts).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseWorkflowJobs } from "./pr-gate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOWS = ".github/workflows";
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const RELEASE = read(`${WORKFLOWS}/release.yml`);

/** Every release workflow (release.yml, release-candidate, the smokes, ...). */
const RELEASE_FILES = readdirSync(path.join(ROOT, WORKFLOWS))
  .filter((f) => /^release.*\.ya?ml$/.test(f))
  .sort();

/** The body of one top-level job in `text`, up to the next job ("" if absent). */
function jobBody(text, id) {
  const start = text.indexOf(`\n  ${id}:\n`);
  if (start === -1) return "";
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** Drop full-line and trailing YAML comments so prose cannot satisfy a check. */
function stripComments(text) {
  return text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/\s+#.*$/, ""))
    .join("\n");
}

/** The job-level `permissions:` map of a job body as { scope: level }. */
function jobPermissions(body) {
  const m = body.match(/\n {4}permissions:[ \t]*([^\n]*)\n((?: {6}[^\n]*\n)*)/);
  if (!m) return null;
  if (m[1].trim()) return { "*": m[1].trim() };
  const perms = {};
  for (const line of m[2].split("\n")) {
    const kv = line.match(/^ {6}([a-z-]+):\s*([a-z-]+)/);
    if (kv) perms[kv[1]] = kv[2];
  }
  return perms;
}

/** Every `uses:` reference in a job body. */
const usesOf = (body) => [...body.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]);

/** Every `run:` script in a job body (inline or block scalar), comments dropped. */
function runScripts(body) {
  const scripts = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!m) continue;
    if (!/^[|>]-?$/.test(m[2].trim())) {
      scripts.push(m[2]);
      continue;
    }
    const indent = m[1].length;
    const block = [];
    for (i++; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() && l.search(/\S/) <= indent) {
        i--;
        break;
      }
      block.push(l);
    }
    scripts.push(stripComments(block.join("\n")));
  }
  return scripts;
}

describe("release workflows never fetch npm code with npx (#4280)", () => {
  it("finds the release workflows", () => {
    expect(RELEASE_FILES).toContain("release.yml");
  });

  it.each(RELEASE_FILES)("%s has no npx call", (file) => {
    expect(stripComments(read(`${WORKFLOWS}/${file}`))).not.toMatch(/\bnpx\b/);
  });
});

describe("@cyclonedx/cyclonedx-npm is a locked, exact devDependency", () => {
  const pkg = JSON.parse(read("package.json"));

  it("is pinned to an exact version", () => {
    const v = pkg.devDependencies?.["@cyclonedx/cyclonedx-npm"];
    expect(v, "@cyclonedx/cyclonedx-npm devDependency").toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is in pnpm-lock.yaml with an integrity hash", () => {
    const v = pkg.devDependencies["@cyclonedx/cyclonedx-npm"];
    const lock = read("pnpm-lock.yaml");
    const entry = lock.indexOf(`\n  '@cyclonedx/cyclonedx-npm@${v}':\n`);
    expect(entry, "lockfile package entry").toBeGreaterThan(-1);
    expect(lock.slice(entry, entry + 400)).toMatch(/integrity: sha512-/);
  });
});

describe("sbom-generate runs the generators without write or signing tokens", () => {
  const body = jobBody(RELEASE, "sbom-generate");
  const code = stripComments(body);

  it("exists", () => {
    expect(body, "sbom-generate job in release.yml").not.toBe("");
  });

  it("declares a read-only token and no OIDC or attestation write", () => {
    expect(jobPermissions(body)).toEqual({ contents: "read" });
  });

  it("never reads a secret", () => {
    expect(code).not.toMatch(/secrets\./);
  });

  it("runs the npm generator from the lockfile via pnpm exec", () => {
    const scripts = runScripts(body).join("\n");
    expect(scripts).toMatch(/pnpm install --frozen-lockfile --ignore-scripts/);
    expect(scripts).toMatch(/pnpm exec cyclonedx-npm\b/);
  });

  it("installs cargo-cyclonedx at a pinned version via a SHA-pinned installer", () => {
    expect(code).toMatch(
      /uses: taiki-e\/install-action@[0-9a-f]{40}\n\s+with:\n\s+tool: cargo-cyclonedx@\d+\.\d+\.\d+\n/
    );
  });

  it("hands the SBOMs on as a workflow artifact", () => {
    expect(usesOf(body).some((u) => u.startsWith("actions/upload-artifact@"))).toBe(true);
    expect(code).toMatch(/name: release-sboms/);
  });
});

describe("sbom attests and uploads without running third-party code", () => {
  const body = jobBody(RELEASE, "sbom");
  const jobs = parseWorkflowJobs(RELEASE);

  it("exists", () => {
    expect(body, "sbom job in release.yml").not.toBe("");
  });

  it("holds the write, OIDC and attestation tokens", () => {
    expect(jobPermissions(body)).toEqual({
      contents: "write",
      "id-token": "write",
      attestations: "write",
    });
  });

  it("needs sbom-generate and the release gates", () => {
    expect(jobs.get("sbom").needs).toEqual(
      expect.arrayContaining([
        "verify-version",
        "verify-supply-chain",
        "create-release",
        "sbom-generate",
      ])
    );
  });

  it("uses only first-party, SHA-pinned actions and no checkout", () => {
    const uses = usesOf(body);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      expect(u, u).toMatch(/^actions\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/);
      expect(u).not.toMatch(/^actions\/checkout@/);
    }
    expect(uses.some((u) => u.startsWith("actions/download-artifact@"))).toBe(true);
    expect(uses.some((u) => u.startsWith("actions/attest-build-provenance@"))).toBe(true);
  });

  it("runs no package-manager or install commands", () => {
    for (const script of runScripts(body)) {
      expect(script).not.toMatch(
        /\b(npx|npm|pnpm|yarn|node|cargo|pip3?|uvx?|curl|wget)\b|\.\/|bash\s+\S+\.sh/
      );
    }
  });

  it("is still what verify-release waits on", () => {
    const verify = jobBody(RELEASE, "verify-release");
    expect(verify).toMatch(/^\s+sbom,$/m);
  });
});

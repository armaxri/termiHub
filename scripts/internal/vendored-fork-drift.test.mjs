import { describe, it, expect } from "vitest";
import {
  compareVersions,
  githubSlug,
  evaluateFork,
  findingsDigest,
  renderReport,
} from "./vendored-fork-drift.mjs";

const SHA = "11a0810cfbbabd8b8023875a05e3041216d4b01b";

const FORK = {
  path: "rdp-sidecar/vendor/ironrdp-rdpsnd",
  crate: "ironrdp-rdpsnd",
  upstream_repo: "https://github.com/Devolutions/IronRDP",
  upstream_branch: "master",
  upstream_path: "crates/ironrdp-rdpsnd",
  base_version: "0.9.0",
  base_commit: SHA,
  reviewed_version: "0.9.0",
  reviewed_commit: SHA,
  watch: { crates_io: "ironrdp-rdpsnd" },
  acknowledged_advisories: [{ id: "RUSTSEC-2099-0001", reason: "fixed in the fork" }],
};

const COMMIT = {
  sha: "c87ab68e9c6adbf524cb0b2783ff4bd61178fb9b",
  date: "2026-08-02T10:00:00Z",
  message: "fix(rdpsnd): isolate malformed encrypted waves (#1514)",
  url: "https://github.com/Devolutions/IronRDP/commit/c87ab68e9",
};

const ADVISORY = {
  id: "RUSTSEC-2099-0002",
  aliases: ["GHSA-aaaa-bbbb-cccc"],
  summary: "Out-of-bounds read in wave PDU",
  url: "https://rustsec.org/advisories/RUSTSEC-2099-0002",
};

describe("compareVersions", () => {
  it("orders by numeric core, pre-releases below their release", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0", "0.9.0")).toBe(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("0.5.3", "0.6.0")).toBeLessThan(0);
  });
});

describe("githubSlug", () => {
  it("extracts owner/repo", () => {
    expect(githubSlug("https://github.com/HsuJv/vnc-rs")).toBe("HsuJv/vnc-rs");
    expect(githubSlug("https://github.com/Devolutions/IronRDP.git")).toBe("Devolutions/IronRDP");
  });

  it("rejects non-GitHub URLs", () => {
    expect(() => githubSlug("https://gitlab.com/a/b")).toThrow(/not a GitHub/);
  });
});

describe("evaluateFork", () => {
  it("is quiet when upstream is level with the reviewed state", () => {
    const result = evaluateFork(FORK, { latestVersion: "0.9.0", commits: [], advisories: [] });
    expect(result.attention).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it("flags a new release, new commits and open advisories", () => {
    const result = evaluateFork(FORK, {
      latestVersion: "0.10.0",
      commits: [COMMIT],
      advisories: [ADVISORY],
    });
    expect(result.attention).toBe(true);
    expect(result.newRelease).toBe("0.10.0");
    expect(result.reasons).toEqual([
      "1 advisory(ies) affect upstream 0.9.0",
      "upstream released 0.10.0",
      "1 new upstream commit(s)",
    ]);
  });

  it("drops acknowledged advisories, matching by id or alias", () => {
    const byAlias = { ...ADVISORY, id: "GHSA-x", aliases: ["RUSTSEC-2099-0001"] };
    const result = evaluateFork(FORK, {
      latestVersion: "0.9.0",
      commits: [],
      advisories: [byAlias],
    });
    expect(result.attention).toBe(false);
    expect(result.acknowledgedCount).toBe(1);
  });

  it("does not flag an older crates.io version than the reviewed one", () => {
    const result = evaluateFork(
      { ...FORK, reviewed_version: "0.10.0" },
      { latestVersion: "0.9.0", commits: [], advisories: [] }
    );
    expect(result.newRelease).toBeNull();
  });
});

describe("findingsDigest", () => {
  it("is stable for the same findings and changes when they change", () => {
    const a = [evaluateFork(FORK, { latestVersion: "0.9.0", commits: [COMMIT], advisories: [] })];
    const b = [evaluateFork(FORK, { latestVersion: "0.9.0", commits: [COMMIT], advisories: [] })];
    const c = [evaluateFork(FORK, { latestVersion: "0.10.0", commits: [COMMIT], advisories: [] })];
    expect(findingsDigest(a)).toBe(findingsDigest(b));
    expect(findingsDigest(a)).not.toBe(findingsDigest(c));
  });
});

describe("renderReport", () => {
  it("lists advisories, releases and commits and embeds the digest", () => {
    const results = [
      evaluateFork(FORK, { latestVersion: "0.10.0", commits: [COMMIT], advisories: [ADVISORY] }),
    ];
    const report = renderReport(results, { generatedAt: "2026-09-26T00:00:00Z", digest: "abc" });
    expect(report).toContain("**1 of 1 vendored fork(s) need a review.**");
    expect(report).toContain(
      "[RUSTSEC-2099-0002](https://rustsec.org/advisories/RUSTSEC-2099-0002)"
    );
    expect(report).toContain("ironrdp-rdpsnd 0.10.0");
    expect(report).toContain("isolate malformed encrypted waves");
    expect(report).toContain("### How to resolve");
    expect(report).toContain("<!-- vendored-fork-drift digest: abc -->");
  });

  it("reports all clear without a resolve section", () => {
    const results = [evaluateFork(FORK, { latestVersion: "0.9.0", commits: [], advisories: [] })];
    const report = renderReport(results, { generatedAt: "2026-09-26T00:00:00Z", digest: "abc" });
    expect(report).toContain("All 1 vendored fork(s) are level");
    expect(report).not.toContain("How to resolve");
  });
});

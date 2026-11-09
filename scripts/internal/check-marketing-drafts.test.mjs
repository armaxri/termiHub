import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import {
  checkRepo,
  checkStamp,
  listDrafts,
  parseStamps,
  staleReason,
} from "./check-marketing-drafts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STAMP = "> Last verified against `develop` at `652dff95f` (2026-10-24).";

describe("parseStamps", () => {
  it("reads branch, commit and date", () => {
    expect(parseStamps(`# Draft\n\n${STAMP}\n`)).toEqual([
      { branch: "develop", sha: "652dff95f", date: "2026-10-24" },
    ]);
  });
});

describe("checkStamp", () => {
  it("accepts exactly one stamp", () => {
    expect(checkStamp("d.md", STAMP)).toEqual([]);
  });
  it("rejects a missing or malformed stamp", () => {
    expect(checkStamp("d.md", "Last verified on 2026-10-24.")[0]).toMatch(
      /d\.md: no "Last verified/
    );
  });
  it("rejects duplicate stamps", () => {
    expect(checkStamp("d.md", `${STAMP}\n${STAMP}`)).toEqual([
      'd.md: 2 "Last verified" stamps — keep exactly one',
    ]);
  });
});

describe("staleReason", () => {
  const git = (behind) => (args) => {
    if (args[0] === "rev-parse") return args[3].startsWith("dead") ? null : "abc123\n";
    return `${behind}\n`;
  };
  it("ignores commits that touch only the drafts", () => {
    const seen = [];
    staleReason("abc123", (args) => (seen.push(args), "0\n"));
    expect(seen[1]).toEqual([
      "rev-list",
      "--count",
      "0..HEAD",
      "--",
      ".",
      ":(exclude)docs/marketing",
    ]);
  });
  it("is null when the stamp is HEAD", () => {
    expect(staleReason("abc123", git(0))).toBeNull();
  });
  it("reports how far behind HEAD the stamp is", () => {
    expect(staleReason("abc123", git(42))).toBe(
      "verified at abc123; 42 later commit(s) outside docs/marketing/"
    );
  });
  it("reports an unknown commit", () => {
    expect(staleReason("deadbeef", git(0))).toBe("commit deadbeef is unknown to this clone");
  });
});

describe("real repository", () => {
  it("lists the drafts but not the folder README", () => {
    const drafts = listDrafts(ROOT);
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts).not.toContain("docs/marketing/README.md");
  });

  it("every marketing draft carries one well-formed stamp", () => {
    expect(checkRepo(ROOT).problems).toEqual([]);
  });

  it("--release flags every draft stamped before HEAD", () => {
    const { stale, drafts } = checkRepo(ROOT, { release: true, git: () => "7\n" });
    expect(stale).toHaveLength(drafts);
  });
});

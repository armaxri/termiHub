import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  SECURITY_MARKER,
  hasSecuritySection,
  isSecurityMarked,
  buildReleaseNotes,
} from "./emit-release-notes.mjs";

// Shared with src-tauri/src/commands/update.rs (`is_security_release`), which
// loads the same file via include_str!, so both detectors stay in sync (#4389).
const SHARED_CASES = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "security-marker-cases.json"),
    "utf8"
  )
);

/** The update-checker CHANGELOG entry that quotes the marker in prose. */
const QUOTED_PROSE =
  "### Added\n\n- Update checker: Security releases (marked `<!-- security -->` in the " +
  "release notes) show a red dot and cannot be silently skipped.";

describe("isSecurityMarked", () => {
  it.each(SHARED_CASES.map((c) => [c.name, c.body, c.marked]))(
    "shared contract case: %s",
    (_name, body, marked) => {
      expect(isSecurityMarked(body)).toBe(marked);
    }
  );

  it("does not treat a marker quoted inline in prose as a security release", () => {
    expect(isSecurityMarked(QUOTED_PROSE)).toBe(false);
  });

  it("detects the marker exactly as buildReleaseNotes emits it", () => {
    expect(isSecurityMarked(buildReleaseNotes("### Security\n\n- patch"))).toBe(true);
    expect(isSecurityMarked(buildReleaseNotes("", { force: true }))).toBe(true);
  });

  it("tolerates CRLF line endings and a leading BOM", () => {
    expect(isSecurityMarked(`${SECURITY_MARKER}\r\n\r\n### Security\r\n`)).toBe(true);
    expect(isSecurityMarked(`\ufeff${SECURITY_MARKER}\n\nnotes`)).toBe(true);
  });

  it("returns false for non-string input", () => {
    expect(isSecurityMarked(undefined)).toBe(false);
    expect(isSecurityMarked(null)).toBe(false);
  });
});

describe("hasSecuritySection", () => {
  it("detects a Keep a Changelog Security heading", () => {
    expect(hasSecuritySection("### Security\n\n- fixed a CVE")).toBe(true);
  });

  it("detects the heading at other levels and with trailing spaces", () => {
    expect(hasSecuritySection("## Security ")).toBe(true);
    expect(hasSecuritySection("#### Security")).toBe(true);
  });

  it("is case-insensitive on the heading text", () => {
    expect(hasSecuritySection("### security")).toBe(true);
    expect(hasSecuritySection("### SECURITY")).toBe(true);
  });

  it("ignores a Security heading that sits among other sections", () => {
    const notes = "### Added\n\n- thing\n\n### Security\n\n- patch\n";
    expect(hasSecuritySection(notes)).toBe(true);
  });

  it("does not match the word security in prose", () => {
    expect(hasSecuritySection("### Fixed\n\n- a security-adjacent bug")).toBe(false);
  });

  it("does not match a heading that merely starts with Security", () => {
    expect(hasSecuritySection("### Security notes for admins")).toBe(false);
  });

  it("returns false for non-string input", () => {
    expect(hasSecuritySection(undefined)).toBe(false);
    expect(hasSecuritySection(null)).toBe(false);
  });
});

describe("buildReleaseNotes", () => {
  it("prepends the marker the app updater looks for when there is a Security section", () => {
    const out = buildReleaseNotes("### Security\n\n- fixed a CVE");
    expect(out.startsWith(`${SECURITY_MARKER}\n\n`)).toBe(true);
    // The exact string src-tauri/src/commands/update.rs greps for.
    expect(out).toContain("<!-- security -->");
    expect(out).toContain("### Security");
  });

  it("leaves a regular release untouched (no marker)", () => {
    const notes = "### Added\n\n- a new feature";
    expect(buildReleaseNotes(notes)).toBe(notes);
    expect(buildReleaseNotes(notes)).not.toContain(SECURITY_MARKER);
  });

  it("emits the marker when forced even without a Security section", () => {
    const out = buildReleaseNotes("### Fixed\n\n- a bug", { force: true });
    expect(out.startsWith(`${SECURITY_MARKER}\n\n`)).toBe(true);
  });

  it("does not duplicate an already-present marker", () => {
    const notes = `${SECURITY_MARKER}\n\n### Security\n\n- patch`;
    const out = buildReleaseNotes(notes);
    expect(out).toBe(notes);
    expect(out.match(/<!-- security -->/g)).toHaveLength(1);
  });

  it("does not duplicate the marker when forced and already present", () => {
    const notes = `${SECURITY_MARKER}\n\n### Fixed\n\n- a bug`;
    expect(buildReleaseNotes(notes, { force: true })).toBe(notes);
  });

  it("prepends the marker when only quoted prose contains it (Security section)", () => {
    const notes = `${QUOTED_PROSE}\n\n### Security\n\n- patched a CVE`;
    const out = buildReleaseNotes(notes);
    expect(out).toBe(`${SECURITY_MARKER}\n\n${notes}`);
    expect(isSecurityMarked(out)).toBe(true);
  });

  it("prepends the marker when only quoted prose contains it (forced)", () => {
    const out = buildReleaseNotes(QUOTED_PROSE, { force: true });
    expect(out).toBe(`${SECURITY_MARKER}\n\n${QUOTED_PROSE}`);
  });

  it("leaves quoted prose unmarked for a non-security release", () => {
    expect(buildReleaseNotes(QUOTED_PROSE)).toBe(QUOTED_PROSE);
    expect(isSecurityMarked(buildReleaseNotes(QUOTED_PROSE))).toBe(false);
  });

  it("does not duplicate a CRLF / BOM-prefixed marker", () => {
    const crlf = `${SECURITY_MARKER}\r\n\r\n### Security\r\n\r\n- patch`;
    expect(buildReleaseNotes(crlf)).toBe(crlf);
    const bom = `\ufeff${SECURITY_MARKER}\n\n### Fixed`;
    expect(buildReleaseNotes(bom, { force: true })).toBe(bom);
  });

  it("emits just the marker when forced on empty notes", () => {
    expect(buildReleaseNotes("", { force: true })).toBe(SECURITY_MARKER);
  });

  it("coerces non-string input to empty notes", () => {
    expect(buildReleaseNotes(undefined)).toBe("");
    expect(buildReleaseNotes(null, { force: true })).toBe(SECURITY_MARKER);
  });
});

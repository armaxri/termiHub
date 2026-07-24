import { describe, it, expect } from "vitest";
import {
  SECURITY_MARKER,
  hasSecuritySection,
  buildReleaseNotes,
} from "./emit-release-notes.mjs";

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
    expect(hasSecuritySection("### Fixed\n\n- a security-adjacent bug")).toBe(
      false,
    );
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

  it("emits just the marker when forced on empty notes", () => {
    expect(buildReleaseNotes("", { force: true })).toBe(SECURITY_MARKER);
  });

  it("coerces non-string input to empty notes", () => {
    expect(buildReleaseNotes(undefined)).toBe("");
    expect(buildReleaseNotes(null, { force: true })).toBe(SECURITY_MARKER);
  });
});

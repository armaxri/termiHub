#!/usr/bin/env node
// Emit the desktop app's self-update *security marker* into a release body.
//
// The in-app self-update check (src-tauri/src/commands/update.rs) decides a
// GitHub release is a *security* update by testing whether the release body
// carries an anchored "<!-- security -->" marker — at the start of the body or
// alone on its own line, never quoted inline in prose (#4389); when it does, the
// update notification drops
// the "Skip this version" action so the patch cannot be suppressed. Nothing in
// the release pipeline used to emit that marker, so security releases never
// actually triggered the bypass (#1878).
//
// This tool bridges that gap: given the release notes generated from the
// changelog, it prepends the marker when the release is security-relevant. A
// release is security-relevant when its notes contain a Keep a Changelog
// "### Security" section (the category documented in docs/changes/README.md and
// docs/contributing.md) — or when a maintainer forces it via the
// TERMIHUB_SECURITY_RELEASE environment variable (the manual checklist path).
//
// The logic lives here (rather than inline in release.yml) so it can be
// unit-tested — see emit-release-notes.test.mjs.

import { readFileSync } from "node:fs";
import { isMainModule } from "./is-main-module.mjs";

/** The exact string src-tauri/src/commands/update.rs looks for. Keep in sync. */
export const SECURITY_MARKER = "<!-- security -->";

/**
 * Does the release body carry the pipeline-emitted security marker?
 *
 * The marker only counts when anchored: at the very start of the body (after an
 * optional BOM and leading whitespace) or alone on its own line — exactly how
 * {@link buildReleaseNotes} emits it. A marker quoted inline in release-note
 * prose (e.g. the CHANGELOG entry describing the update checker) does not count
 * (#4389). CRLF line endings are tolerated.
 *
 * Mirrors `is_security_release` in src-tauri/src/commands/update.rs; both are
 * pinned by the shared cases in security-marker-cases.json.
 *
 * @param {unknown} notes - Release notes / release body.
 * @returns {boolean} True when an anchored marker is present.
 */
export function isSecurityMarked(notes) {
  if (typeof notes !== "string") {
    return false;
  }
  // `trim()` strips U+FEFF too, so a leading BOM is ignored.
  if (notes.trimStart().startsWith(SECURITY_MARKER)) {
    return true;
  }
  return notes.split(/\r?\n/).some((line) => line.trim() === SECURITY_MARKER);
}

/**
 * A Keep a Changelog "Security" category heading (`## Security` … `#### Security`),
 * on its own line, case-insensitive, with optional trailing whitespace. Anchored
 * so "### Security notes" or prose mentioning "security" does not match.
 */
const SECURITY_HEADING = /^#{2,4}[ \t]+Security[ \t]*$/im;

/**
 * Does the release body contain a Keep a Changelog Security section?
 *
 * @param {unknown} notes - Release notes / changelog body.
 * @returns {boolean} True when a `### Security` heading is present.
 */
export function hasSecuritySection(notes) {
  return typeof notes === "string" && SECURITY_HEADING.test(notes);
}

/**
 * Prepend the self-update security marker to release notes when the release is
 * security-relevant. Idempotent: an already-marked body is returned unchanged,
 * so re-running never duplicates the marker.
 *
 * @param {unknown} notes - Release notes generated from the changelog.
 * @param {{ force?: boolean }} [options] - `force` emits the marker regardless
 *   of whether a Security section is present (maintainer override).
 * @returns {string} The notes, with the marker prepended when applicable.
 */
export function buildReleaseNotes(notes, { force = false } = {}) {
  const body = typeof notes === "string" ? notes : "";
  if (isSecurityMarked(body)) {
    return body;
  }
  if (!force && !hasSecuritySection(body)) {
    return body;
  }
  return body.length > 0 ? `${SECURITY_MARKER}\n\n${body}` : SECURITY_MARKER;
}

// CLI mode: read notes from the file named in argv[2] (or stdin when it is "-"),
// honour TERMIHUB_SECURITY_RELEASE as the force override, and print the possibly
// marked notes to stdout so the workflow can redirect them back into the file.
if (isMainModule(import.meta.url)) {
  const source = process.argv[2] ?? "-";
  const raw = readFileSync(source === "-" ? 0 : source, "utf8");
  const forceValue = (process.env.TERMIHUB_SECURITY_RELEASE ?? "").trim().toLowerCase();
  const force = forceValue !== "" && forceValue !== "0" && forceValue !== "false";
  process.stdout.write(buildReleaseNotes(raw, { force }));
}

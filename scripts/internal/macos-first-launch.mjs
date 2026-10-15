#!/usr/bin/env node
// The single source of the macOS first-launch steps for the unsigned beta (#4279).
//
// v0.x ships unsigned (no Apple Developer ID / notarization), so every macOS user
// has to approve the app once on first launch. macOS 15 (Sequoia) removed the
// right-click → Open override for unnotarized apps: the approval now lives in
// System Settings → Privacy & Security → Open Anyway. The `xattr` one-liner
// works on every version.
//
// Three surfaces carry these steps and must not drift apart:
//   - the release body: release.yml runs this script and appends its output;
//   - the dev-build release body: dev-build.yml runs this script with
//     --dev-build, which keeps the "Dev Build" framing (#4472);
//   - README.md: the macOS install section embeds FIRST_LAUNCH_STEPS between
//     the README_BEGIN / README_END markers.
// macos-first-launch.test.mjs checks that README.md carries the current steps
// and that release.yml and dev-build.yml call this script.
//
// Usage:
//   node scripts/internal/macos-first-launch.mjs >> release_notes.md
//   node scripts/internal/macos-first-launch.mjs --dev-build   # dev-build.yml

import { isMainModule } from "./is-main-module.mjs";

/** Marker lines that delimit the steps embedded in README.md. */
export const README_BEGIN = "<!-- macos-first-launch:begin -->";
export const README_END = "<!-- macos-first-launch:end -->";

/** The canonical first-launch steps, as a Markdown list. */
export const FIRST_LAUNCH_STEPS = [
  "- **macOS 15 (Sequoia) and later:** open the app once and dismiss the warning, then open " +
    "**System Settings → Privacy & Security**, scroll to **Security** and click **Open Anyway**. " +
    "Confirm with **Open** (and your password if asked).",
  "- **Any macOS version, from a terminal:** " +
    "`xattr -dr com.apple.quarantine /Applications/termiHub.app`",
  "- **macOS 14 (Sonoma) and earlier only:** right-click (or Control-click) the app → " +
    "**Open** → **Open**.",
].join("\n");

/**
 * The block release.yml appends to every release body. It starts with a
 * separator so it follows the changelog notes (and the security marker, which
 * must stay first in the body) cleanly.
 *
 * @returns {string} Markdown, ending in a newline.
 */
export function renderReleaseBody() {
  return [
    "",
    "---",
    "",
    "### macOS — unsigned public beta (one-time approval)",
    "",
    "termiHub is an **unsigned public beta** (no Apple Developer ID / notarization yet).",
    "The app is ad-hoc signed so it runs, but on first launch macOS warns that the",
    "developer cannot be verified. Approve it once, either way:",
    "",
    FIRST_LAUNCH_STEPS,
    "",
    "macOS remembers the approval, so later launches work normally.",
    "",
  ].join("\n");
}

/**
 * The note dev-build.yml puts in every dev-build release body: a Markdown
 * blockquote with the "Dev Build" framing around the same canonical steps.
 * It sits between the installer and agent tables, so it carries no separator.
 *
 * @returns {string} Markdown, ending in a newline.
 */
export function renderDevBuildNote() {
  const lines = [
    "**macOS — one-time security confirmation required.** These dev builds are not notarized",
    "(no Apple Developer account). On first launch macOS warns that the developer cannot be",
    "verified. Approve it once, either way:",
    "",
    ...FIRST_LAUNCH_STEPS.split("\n"),
    "",
    "This is a one-time step; later launches work normally.",
  ];
  return lines.map((line) => (line ? `> ${line}` : ">")).join("\n") + "\n";
}

/**
 * Pick the block to print from the CLI arguments.
 *
 * @param {string[]} args process.argv.slice(2)
 * @returns {string} the Markdown to write to stdout
 */
export function renderForArgs(args) {
  const unknown = args.filter((arg) => arg !== "--dev-build");
  if (unknown.length > 0) {
    throw new Error(`unknown argument(s): ${unknown.join(" ")} (expected: [--dev-build])`);
  }
  return args.includes("--dev-build") ? renderDevBuildNote() : renderReleaseBody();
}

if (isMainModule(import.meta.url)) {
  try {
    process.stdout.write(renderForArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(`macos-first-launch: ${err.message}`);
    process.exit(2);
  }
}

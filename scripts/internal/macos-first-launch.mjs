#!/usr/bin/env node
// The single source of the macOS first-launch steps for the unsigned beta (#4279).
//
// v0.x ships unsigned (no Apple Developer ID / notarization), so every macOS user
// has to approve the app once on first launch. macOS 15 (Sequoia) removed the
// right-click → Open override for unnotarized apps: the approval now lives in
// System Settings → Privacy & Security → Open Anyway (the flow dev-build.yml's
// release body already documents). The `xattr` one-liner works on every version.
//
// Two surfaces carry these steps and must not drift apart:
//   - the release body: release.yml runs this script and appends its output;
//   - README.md: the macOS install section embeds FIRST_LAUNCH_STEPS between
//     the README_BEGIN / README_END markers.
// macos-first-launch.test.mjs checks that README.md and dev-build.yml carry the
// current steps and that release.yml calls this script.
//
// Usage: node scripts/internal/macos-first-launch.mjs >> release_notes.md

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

if (isMainModule(import.meta.url)) {
  process.stdout.write(renderReleaseBody());
}

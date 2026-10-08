---
id: PKG2-009
title: "The macOS re-sign step rebuilds the DMG from the bare .app, dropping Tauri's /Applications drop link and layout"
angle: packaging-release
severity: low
category: packaging
is_workaround: true
subsystem: ".github/workflows/release.yml (Re-sign macOS DMG)"
evidence:
  - .github/workflows/release.yml:556-560
  - .github/workflows/release.yml:626-627
  - .github/workflows/dev-build.yml:394
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

After re-signing, the step deletes Tauri's DMG and recreates it with `hdiutil create -volname termiHub -srcfolder "$APP"`. Only the .app is copied from the original image. Tauri's DMG also contains an `/Applications` symlink and its window layout (drag-to-install), and the rebuilt image has neither. The release smoke installs by ditto from the mount, so it cannot detect this.

## Why it matters

Without the Applications shortcut, users tend to launch the app straight from the read-only mounted DMG. There it runs App-Translocated with quarantine, which makes the Gatekeeper bypass and later updates more confusing. It is a small but avoidable regression from the stock Tauri DMG UX.

## Evidence

- `.github/workflows/release.yml:556-560`
- `.github/workflows/release.yml:626-627`
- `.github/workflows/dev-build.yml:394`

## Recommendation

Stage the re-signed app in a folder with `ln -s /Applications "$STAGE/Applications"` and run `hdiutil create -srcfolder "$STAGE"`. Better: re-run Tauri's own DMG bundling script (bundle_dmg.sh) on the re-signed .app so the layout is kept. Mirror the change in dev-build.yml.

## Verification

Confirmed. The re-sign step copies only the .app out of the mounted image (ditto "$MOUNT/$APP_NAME"), deletes the original DMG, and runs hdiutil create -srcfolder "$APP". The /Applications drop link and layout that Tauri's bundle_dmg.sh adds are lost. This is a UX regression only.

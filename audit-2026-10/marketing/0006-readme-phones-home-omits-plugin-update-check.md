---
id: MKT2-006
title: "README 'What phones home' statement omits the opt-in daily plugin update check to third-party URLs"
angle: marketing / product positioning
severity: low
category: trust
is_workaround: false
subsystem: "README.md / plugins"
evidence:
  - "README.md:89"
  - "src/components/Settings/settingsRegistry.ts:714-719"
  - "src/hooks/usePluginUpdateSchedule.ts:16-23"
  - "src/plugins/pluginUpdateStore.ts:4-12"
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

README.md:89 says the GitHub Releases update check 'is the only network call termiHub makes on its own', and names only the click-triggered plugin index fetch as another source. There is also 'Check for Plugin Updates Automatically' (settingsRegistry.ts:714-719, usePluginUpdateSchedule.ts). When enabled, it contacts each installed plugin's own `updateUrl` once a day, which can be any third-party HTTPS host, as well as the plugin index.

## Why it matters

The privacy note is an explicit trust promise. It is opt-in and off by default, so the claim is technically defensible, but a precise list of automatic calls is the point of the note. Omitting a periodic call to arbitrary third-party hosts invites a 'the README said it only calls GitHub' complaint.

## Evidence

- `README.md:89`
- `src/components/Settings/settingsRegistry.ts:714-719`
- `src/hooks/usePluginUpdateSchedule.ts:16-23`
- `src/plugins/pluginUpdateStore.ts:4-12`

## Recommendation

Add one sentence to README.md:89: 'If you turn on Settings → Plugins → Check for Plugin Updates Automatically (off by default), termiHub also checks, once a day, the update URL published by each installed plugin and the plugin index.'

## Verification

Confirmed. README:89 says the GitHub release check is 'the only network call termiHub makes on its own'. usePluginUpdateSchedule.ts runs a daily check of each plugin's own updateUrl and the plugin index when pluginUpdateCheckEnabled is on. The check is opt-in and off by default, hence low.

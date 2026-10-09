---
id: PKG2-002
title: "Deploying the agent to a Windows host downloads `termihub-agent-windows-x64` (no .exe), which no release publishes; dev releases ship no Windows agent at all"
angle: packaging-release
severity: high
category: packaging
is_workaround: false
subsystem: "src-tauri/src/terminal/agent_binary.rs + release/dev-build asset naming"
evidence:
  - src-tauri/src/terminal/agent_binary.rs:57-61
  - src-tauri/src/terminal/agent_binary.rs:565-573
  - src-tauri/src/terminal/agent_binary.rs:619
  - src-tauri/src/terminal/agent_binary.rs:424
  - src-tauri/src/terminal/agent_binary.rs:104-108
  - src-tauri/src/terminal/agent_binary.rs:129
  - src-tauri/src/terminal/agent_deploy.rs:317
  - src-tauri/src/terminal/agent_deploy.rs:337
  - .github/workflows/release.yml:856-859
  - .github/workflows/release.yml:896-900
  - .github/workflows/dev-build.yml:442
  - .github/workflows/dev-build.yml:518
  - .github/workflows/dev-build.yml:636-647
  - src-tauri/src/terminal/agent_manager/windows_ssh_host_tests.rs:31-34
status: fixed
resolution: "#4302 — one core asset-name scheme (.exe for Windows) drives deploy URLs, sidecars, cache and bundle; dev builds publish Windows agents"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

For a Windows remote, `artifact_name_for_os_arch` returns `windows-x64` or `windows-arm64`. `compute_download_url` builds `.../releases/download/v{ver}/termihub-agent-` plus that suffix, and the checksum and signature URLs are that URL plus `.sha256` / `.sig`. release.yml, however, publishes `termihub-agent-windows-x64.exe`, `.exe.sha256` and `.exe.sig` (same for arm64). The immediate deploy path (agent_deploy.rs:317/337, which also serves Windows hosts through windows_install_plan) therefore requests an asset that does not exist and gets a 404. The bundled lookup (`termihub-agent-{suffix}`) and the cache path have the same naming. Dev builds fail even if the name were fixed: dev-build.yml has only Linux and macOS agent jobs, and the live dev-develop-latest release has no Windows agent asset (checked with gh). The Windows SSH-host lane deliberately bypasses binary resolution by uploading a locally built exe (windows_ssh_host_tests.rs:31-34), and no unit test pins the Windows download URL to release.yml's asset names, so nothing catches the mismatch.

## Why it matters

Deploying the agent to a Windows host, a documented feature (#3060 added the ARM64 asset specifically 'so those hosts can install the agent'), fails for every release and dev-build user unless they sideload the binary by hand. Release automation makes it worse: the smokes download the .exe assets directly, so the real deploy URL is never exercised.

## Evidence

- `src-tauri/src/terminal/agent_binary.rs:57-61`
- `src-tauri/src/terminal/agent_binary.rs:565-573`
- `src-tauri/src/terminal/agent_binary.rs:619`
- `src-tauri/src/terminal/agent_binary.rs:424`
- `src-tauri/src/terminal/agent_binary.rs:104-108`
- `src-tauri/src/terminal/agent_binary.rs:129`
- `src-tauri/src/terminal/agent_deploy.rs:317`
- `src-tauri/src/terminal/agent_deploy.rs:337`
- `.github/workflows/release.yml:856-859`
- `.github/workflows/release.yml:896-900`
- `.github/workflows/dev-build.yml:442`
- `.github/workflows/dev-build.yml:518`
- `.github/workflows/dev-build.yml:636-647`
- `src-tauri/src/terminal/agent_manager/windows_ssh_host_tests.rs:31-34`

## Recommendation

Introduce one function, `release_asset_name(arch_suffix)`, that appends `.exe` for `windows-*`, and use it for the download URL, the sidecar URLs, the bundled lookup and the cache file name. Add a unit test that pins every suffix's asset name to the list in release.yml's verify-release `agents=(...)`, or better, generate both from one shared list checked by a CI contract script. Add Windows x64 and arm64 agent legs to dev-build.yml so dev desktops can deploy to Windows hosts too.

## Verification

I checked the evidence against the code and the finding holds. For a Windows remote, artifact_name_for_os_arch (agent_binary.rs:57-61) returns "windows-x64" or "windows-arm64". compute_download_url (lines 565-573) then builds `…/releases/download/v{ver}/termihub-agent-` plus that suffix. Line 424 adds the `.sha256` sidecar URL, and the `.sig` URL is built the same way. Nothing on any of these paths appends ".exe": the cached path (104-108), the bundled lookup (129), the download (619) and resolve_agent_binary (638+). rg found no `.exe` handling in agent_binary.rs or agent_deploy.rs.

The release side publishes something else. release.yml:856-859 publishes `termihub-agent-windows-x64.exe` and `termihub-agent-windows-arm64.exe`, and both verify-release `agents=(...)` lists (lines 1108 and 1209) name the `.exe` assets too. A release desktop deploying to a Windows host (agent_deploy.rs:317/337) therefore requests a URL with no matching asset and gets a 404.

The repo itself shows the drift. scripts/build-agents.sh:16 says "CI renames artifacts to termihub-agent-windows-x64 / -windows-arm64", which no longer matches release.yml. A test at agent_binary.rs:1072 uses a `.exe` name, but only as text inside a checksum line; no test ties the Windows download URL to a published asset name.

dev-build.yml has no agent build legs for Windows. Its only Windows job is the desktop build (lines 68-73), so dev builds cannot fetch a Windows agent either.

I found no ADR or decision in docs/architecture.md that explains the mismatch. Lines 1173-1180 say outright that the published Windows agent assets are `.exe`.

I kept the severity at high. Deploying the agent to a Windows host is a documented feature (#3060, #4175), and it fails on the default resolution path for every release user unless they put the binary in place by hand. It is not critical: nothing is lost or exposed, and the failure is a loud 404, not silent corruption.

# Package Manager for Extensions and Tools

**GitHub Issue:** [#521](https://github.com/armaxri/termiHub/issues/521)

> **Folder-form concept** (AI-driven concept workflow). Visual surfaces live in
> [`mockups/`](mockups/), behavior diagrams in [`behavior.md`](behavior.md), and the
> concept↔code reconciliation ledger in [`sync.md`](sync.md). The concept is the source of
> truth; run `/sync-concept package-manager` to reconcile it with the implementation.

---

## Overview

The [Plugin System concept](../plugin-system/concept.md) defines how termiHub loads
and runs extensions at runtime — but it only supports local, manual installation
from `.termihub-plugin` files. There is no way to discover, browse, or
automatically update plugins, and no mechanism to manage tool packages for an
embedded Unix environment.

This concept introduces a **Package Manager** that sits on top of the plugin
system and provides:

- **A curated plugin repository** with browsable catalog, search, and
  categorization
- **Dependency resolution** between plugins and external tool requirements
- **Automatic updates** with user-controlled update policies
- **Tool packages** (CLI utilities, shells, compilers) that can be installed into
  a local tools directory — analogous to MobaXterm's MobApt
- **Size management** with disk usage tracking and cleanup utilities

### Relationship to Existing Concepts

| Concept                                                                     | Scope                                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Plugin System](../plugin-system/concept.md)                                | Runtime loading, extension points, sandboxing, permissions                            |
| **Package Manager** (this document)                                         | Discovery, repository, dependency resolution, updates, tool packages                  |
| [Embedded Unix Environment](../../backlog/embedded-unix-windows/concept.md) | Bundled Unix tools on Windows — the package manager could serve as its package source |

The package manager **depends on** the plugin system being implemented first. It
extends the plugin system's "Install from file" workflow into a full
repository-backed package lifecycle.

### Goals

- Provide a **repository** of curated and community-contributed packages
- Support **two package types**: plugins (termiHub extensions) and tools (CLI
  utilities)
- Enable **one-click install** of plugins from the repository
- Handle **dependency resolution** between packages
- Support **automatic and manual updates** with configurable policies
- Show **installed size** per package and total disk usage
- Allow **multiple repository sources** (official, community, private/corporate)
- Work **cross-platform** (Windows, macOS, Linux) with platform-aware packages

### Non-Goals

- Hosting the repository infrastructure (CDN, backend) — this concept covers the
  client-side design only
- Paid plugins or a commercial marketplace
- User ratings, reviews, or social features in the initial version
- Plugin development tooling (SDK, scaffolding, testing framework)
- Running tool packages inside a containerized or sandboxed environment

---

## UI Interface

The visual surfaces are specified by the mockups — open them in a browser to review layout and
states. This section describes them; the mockups are authoritative for layout.

| Mockup                                                                               | Shows                                                                                                                                                                        |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`mockups/package-manager-browse.html`](mockups/package-manager-browse.html)         | New **Packages** Activity Bar view: Browse tab (search, category filter, package cards) and Installed tab (per-package size, update chips, total-size footer, update banner) |
| [`mockups/package-detail-and-install.html`](mockups/package-detail-and-install.html) | Package Detail panel (install vs. installed variants) and the Install / Tool-install confirm dialog with dependency review                                                   |

### Activation point

A new **Packages** entry (lucide `Package` icon) sits in the **Activity Bar**, replacing the
plugin system's planned "Plugins" item. Selecting it opens the Package Manager sidebar view, which
carries two tabs: **Browse** (repository) and **Installed** (local). See
`mockups/package-manager-browse.html` states 1 and 2.

### Browse tab

The Browse tab fetches the merged repository index and renders it as cards grouped into sections:
**Featured**, **Terminal Backends**, and **Tools**. Above the cards sit a search box (filters by
name, description, tags, author — client-side) and a category filter dropdown (All / Plugins →
Backends, Themes, Protocol Parsers, Status Widgets / Tools → Shells, Utilities, Compilers,
Languages). Each card shows the package name, a type glyph (plugin vs. tool), version, download
count or size, and an **Install** button. See `mockups/package-manager-browse.html` state 1.

### Installed tab

The Installed tab lists locally installed packages grouped by type (**Plugins**, **Tools**), each
with a state dot, version, and **on-disk size**. Packages with a newer version available show an
amber **update chip** (`⬆ Update: vX.Y.Z`); up-to-date packages show a `✓ Up to date` marker. A
footer shows the **total size** and a **Clean unused…** action. When updates exist, a subtle
**update banner** appears at the top of the tab with **Update All**, **Review…**, and **Dismiss**
actions. See `mockups/package-manager-browse.html` state 2.

### Package detail panel

Clicking any card (in either tab) opens a **detail panel** in the sidebar showing the description,
category, downloads, size, license, dependencies, permissions, and changelog. The action row is
context-dependent: **Install** / **Homepage** when not installed; **Update** / **Disable** /
**Uninstall** / **Settings** when installed. See `mockups/package-detail-and-install.html`
states 1 and 2.

### Install confirmation

Installing a package that pulls in dependencies opens an **Install confirm dialog** built on the
`.menu` overlay. It lists the resolved install order (primary package plus auto-installed
dependencies), notes any **external** requirements (e.g. `kubectl`) that the user must provide, and
shows total download/install size. The **Tool-install** variant additionally shows the target tools
directory and platform/arch. See `mockups/package-detail-and-install.html` state 3.

### Package Manager settings

A new **Packages** category in the Settings panel governs auto-update policy (check interval,
auto-install toggle, include pre-release), repository sources (official/community/corporate with
priority ordering and **Add source…**), the tools directory path, and a disk-usage breakdown with
**Clear cache**. This panel is described here but not mocked separately.

### Keyboard / discoverability

The Packages view is reachable purely through the Activity Bar item; there is no global shortcut in
v1. Tool packages, once installed, are immediately available on `PATH` for all new terminal
sessions without further user action.

---

## General Handling

Detailed flows, the install/update pipelines, dependency resolution, PATH integration, and
error-handling state machines are diagrammed in [`behavior.md`](behavior.md). Key rules:

### Package types

The package manager handles two distinct package types:

| Aspect             | Plugin Packages                             | Tool Packages                               |
| ------------------ | ------------------------------------------- | ------------------------------------------- |
| **Purpose**        | Extend termiHub (backends, themes, parsers) | Provide CLI utilities for terminal sessions |
| **Format**         | `.termihub-plugin` (ZIP with manifest)      | Platform-specific archives (tar.gz / zip)   |
| **Location**       | `<app-data>/plugins/<id>/`                  | `<app-data>/tools/<id>/`                    |
| **Runtime**        | Loaded by Plugin Manager at app startup     | Available in `PATH` for all sessions        |
| **Activation**     | Requires explicit enable                    | Available immediately after install         |
| **Dependencies**   | Other plugins or external tools             | Other tool packages                         |
| **Cross-platform** | May include per-platform native libraries   | Always platform-specific binaries           |

### Repository structure

The package repository is a static file index served over HTTPS. No dynamic backend is required —
the repository can be hosted on any CDN or static file host.

```
Repository (HTTPS)
├── index.json              # Full package catalog
├── plugins/
│   ├── k8s-exec/
│   │   ├── metadata.json   # Package metadata + all versions
│   │   └── 1.2.0/
│   │       ├── k8s-exec-1.2.0-<platform>-<arch>.termihub-plugin
│   │       └── checksums.sha256
│   └── dracula-theme/ …
└── tools/
    ├── git/
    │   ├── metadata.json
    │   └── 2.44.0/
    │       ├── git-2.44.0-<platform>-<arch>.{zip,tar.gz}
    │       └── checksums.sha256
    └── python/ …
```

The `index.json` provides a compact catalog (`id`, `name`, `type`, `category`, `author`,
`description`, `latestVersion`, `platforms`, `downloads`, `featured`, `tags`) for the Browse UI;
per-package `metadata.json` (versions, changelogs, dependencies, platform assets) is fetched on
demand when a detail panel opens.

### Browsing and search

1. On first open of Browse, the client fetches `index.json` from configured repository sources.
2. The merged index is cached locally with a configurable TTL (default: 24 hours).
3. Search filters client-side on `name`, `description`, `tags`, and `author`.
4. The category filter narrows by `type` and `category`.

### Installing a package

The user clicks **Install**; the manager resolves dependencies, shows the confirm dialog when
extra packages are pulled in, then downloads each archive, verifies its SHA-256 checksum (and code
signature when present), extracts it, and registers it with the plugin system (plugins) or the
managed-PATH registry (tools). See the **Installing a Package** sequence in `behavior.md`.

### Updating packages

Updates are discovered on an interval (daily/weekly/manual) by re-fetching the index with
`If-None-Match`. Available updates surface as the Installed-tab banner. **Update All** or a reviewed
subset downloads and replaces each package; plugins with active sessions are queued for the next app
restart rather than swapped underneath a live session. See the **Updating Packages** flowchart in
`behavior.md`.

### Dependency resolution

Dependencies are declared in package metadata. The resolver does a topological sort with
circular-dependency and conflict detection:

| Dependency Type        | Example                                       | Resolution                                                          |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| **Plugin → Plugin**    | SSH Tunnel plugin depends on SSH Utils plugin | Auto-install SSH Utils first                                        |
| **Plugin → Tool**      | K8s Exec plugin requires `kubectl`            | Prompt to install kubectl tool package or note external requirement |
| **Tool → Tool**        | `git` depends on `openssl`                    | Auto-install openssl first                                          |
| **Version constraint** | `>=1.0.0, <2.0.0`                             | Install latest compatible version                                   |
| **Conflict**           | Two plugins provide the same connection type  | Block install, show conflict message                                |

### Uninstalling a package

1. Check whether other installed packages depend on this one; warn and offer to uninstall
   dependents.
2. If the package is a plugin with active sessions, warn that sessions will close.
3. Remove files from disk, update the installed list and PATH registry, and clear package settings.

### Size management and cleanup

Each package tracks its on-disk size; the Installed tab shows per-package and total size. The
**Clean unused** action identifies tool packages unused for 90+ days, download cache files older
than 7 days, and orphaned plugin data. Cleanup is always user-confirmed, never automatic.

### Multiple repository sources

Users configure multiple sources with priority ordering — **Official** (always present),
**Community** (opt-in), and **Private/Corporate**. When the same package ID exists in several
repos, the highest-priority source wins. See the **Repository Source Resolution** flow in
`behavior.md`.

### Offline mode

With no network: Browse shows the cached index with a "cached" indicator; install/update fail
gracefully with a clear message; already-installed packages and on-disk tools keep working.

### Edge cases

- **Platform-limited package**: shows "Not available for your platform" instead of Install, with a
  note about supported platforms.
- **Insufficient disk space**: checked before download; aborts with a clear message.
- **Download interrupted**: resumed via HTTP range requests, falling back to re-download.
- **Repository unreachable**: retried with exponential backoff (3 attempts) then falls back to the
  cached index.
- **Malicious package**: caught by checksum and (when available) code-signature verification.
- **Version downgrade**: explicitly supported via "Install specific version", with a settings-loss
  warning.
- **Conflict with built-in**: built-in features always win; the conflicting package cannot install.

---

## Preliminary Implementation Details

Based on the current project architecture at concept-creation time; the codebase may evolve before
implementation. The architecture diagram lives in [`behavior.md`](behavior.md).

### Package metadata types (Rust)

A new `core/src/packages/` module defines the catalog and metadata types. `PackageInfo` is the
compact index entry (`id`, `name`, `package_type`, `category`, `author`, `description`,
`latest_version`, `platforms`, `downloads`, `featured`, `tags`). `PackageMetadata` adds the full
`versions` list (each `VersionEntry` carries `changelog`, `dependencies`, `size_bytes`, and
per-platform `PlatformAsset` download URLs + checksums), `license`, `homepage`, and `repository`.
`PackageType` is `Plugin | Tool`; `DependencyType` is `Required` (auto-resolved) or `External`
(noted but not auto-installed); `Platform` is `Windows | Linux | Macos` and `Arch` is
`X86_64 | Aarch64`.

### Package Manager service (Rust)

The `PackageManager` lives in `src-tauri/src/packages/manager.rs` and orchestrates repository
access, downloads, and local package state. It holds the ordered `repositories`, a cached merged
index (with per-repo ETags), `LocalPackageState` (installed packages + enabled/disabled +
settings), a `reqwest::Client`, and the `packages_dir` / `tools_dir` paths. Its surface:
`refresh_index`, `get_index`, `get_package_metadata`, `resolve_install`, `execute_install`,
`check_updates`, `uninstall`, `list_installed`, `disk_usage`, `clean_cache`, and
`managed_path_entries`.

### Dependency resolver

`src-tauri/src/packages/resolver.rs` provides `DependencyResolver`, which reads the target version's
dependency list, recursively resolves each dependency against the index and installed set, detects
circular dependencies and conflicts, topologically sorts into an install order, separates external
dependencies, and computes total download/install sizes — returning an `InstallPlan` of
`InstallStep`s plus `ExternalDep`s.

### Tauri commands

`src-tauri/src/commands/packages.rs` exposes: `get_package_index(force_refresh)`,
`get_package_detail(package_id)`, `resolve_package_install(package_id, version)`,
`install_package(package_id, version)`, `uninstall_package(package_id)`, `check_package_updates`,
`update_packages(package_ids)`, `get_installed_packages`, `get_package_disk_usage`,
`clean_package_cache`, `get_repository_sources`, and `update_repository_sources(sources)`.
Install/update progress streams to the UI via Tauri events
(`download-start/-progress/-complete`, `install-start/-complete/-error`).

### Frontend types, store, and components

`src/types/packages.ts` mirrors the Rust types (`PackageInfo`, `PackageMetadata`, `VersionEntry`,
`PackageDependency`, `InstalledPackage`, `InstallPlan`, `InstallStep`, `UpdateInfo`, `DiskUsage`,
`RepositorySource`). `appStore.ts` gains `packageIndex`, `installedPackages`, `availableUpdates`,
and `packageIndexLoading` state plus `loadPackageIndex`, `loadInstalledPackages`, `installPackage`,
`uninstallPackage`, `checkPackageUpdates`, and `updatePackages` actions.

| Component              | Location                                           | Purpose                                              |
| ---------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| `PackageManagerView`   | `src/components/Packages/PackageManagerView.tsx`   | Main sidebar view with Browse/Installed tabs         |
| `PackageBrowseTab`     | `src/components/Packages/PackageBrowseTab.tsx`     | Repository browsing with search and filters          |
| `PackageInstalledTab`  | `src/components/Packages/PackageInstalledTab.tsx`  | List of installed packages with sizes                |
| `PackageCard`          | `src/components/Packages/PackageCard.tsx`          | Card component for package in list                   |
| `PackageDetailPanel`   | `src/components/Packages/PackageDetailPanel.tsx`   | Expanded detail view for a package                   |
| `InstallConfirmDialog` | `src/components/Packages/InstallConfirmDialog.tsx` | Dependency review and install confirmation           |
| `UpdateBanner`         | `src/components/Packages/UpdateBanner.tsx`         | Update notification banner                           |
| `PackageSettings`      | `src/components/Settings/PackageSettings.tsx`      | Settings panel for repositories, updates, disk usage |

### Activity Bar integration

The Activity Bar gains a `packages` item (lucide `Package`) and the Sidebar a conditional branch
rendering `<PackageManagerView />` when `sidebarView === "packages"`. This replaces the plugin
system's planned "Plugins" item.

### Tool PATH management

Tool binaries are added to the `PATH` of every new terminal session. Session spawning (in
`src-tauri/src/terminal/backend.rs` / session setup) reads `managed_path_entries()` and prepends
them to the inherited `PATH`, joined with the platform path separator, so freshly installed tools
(`git`, `python`, …) are immediately resolvable. See the **Tool PATH Integration** sequence in
`behavior.md`.

### Local state persistence

Package manager state persists as JSON in the app data directory: `package-state.json` (installed +
enabled/disabled), `package-settings.json` (per-package config), `package-repos.json` (sources), a
`package-cache/` of downloaded archives, and a `repo-cache/` of cached index files.

### Implementation order

1. **Metadata types + repository client** — `PackageInfo`/`PackageMetadata` in core; index fetch +
   cache; basic retrieval commands.
2. **Local state + dependency resolver** — `LocalPackageState` persistence; topological resolver
   with conflict detection; install-plan resolution.
3. **Download + installation pipeline** — download manager (checksum verify, progress events,
   retry); plugin registration; tool extraction + PATH management.
4. **Package Manager UI (Browse)** — `PackageManagerView`, `PackageBrowseTab`, `PackageCard`,
   `PackageDetailPanel`; Activity Bar + Sidebar wiring.
5. **Package Manager UI (Installed + updates)** — `PackageInstalledTab`, `UpdateBanner`,
   `InstallConfirmDialog`; update checking and batch updates.
6. **Settings + cleanup** — `PackageSettings` (sources, update policy, disk usage, cache cleanup).
7. **Polish + docs** — error-handling edge cases, offline mode, source priority, user docs.

---

## Implementation Status

Not started — this is a `future/` concept. Once implementation begins, run
`/sync-concept package-manager` after each change to keep [`sync.md`](sync.md) current.

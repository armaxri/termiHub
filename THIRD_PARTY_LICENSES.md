# Third-Party Licenses

termiHub itself is licensed under the [MIT License](LICENSE).

termiHub's third-party attribution has two parts:

1. **Bundled dependencies — generated.** The desktop app, the remote agent and the
   RDP sidecar are built from hundreds of Rust crates and npm packages whose
   licenses require their copyright notice and license text to accompany the
   binary. These notices are **generated from the real dependency graph**
   (`Cargo.lock`, `rdp-sidecar/Cargo.lock`, `pnpm-lock.yaml`) into
   `THIRD_PARTY_NOTICES.txt` by `pnpm notices:generate` at release time. Every
   installer bundles that file — it is what the in-app **About → Third-Party
   Licenses** viewer shows — and each release publishes it as
   `termiHub-<version>-THIRD_PARTY_NOTICES.txt` next to the agent binaries.
2. **External programs, bundled native binaries and bundled fonts — this file.**
   The sections below document third-party programs that termiHub **installs
   and invokes** (but does **not** bundle or redistribute), and the prebuilt
   native binaries and font files it **does** bundle that do not come from a
   lockfile (the Windows ConPTY host, the Geist and MesloLGS Nerd Font Mono
   fonts), together with their license texts and upstream source pointers.
   This content and the license texts are also copied into the generated
   notices.

> **Scope note.** The external programs are the X servers used for SSH X11
> forwarding (see the
> [X server provisioning concept](docs/concepts/implemented/x-server-provisioning.html)
> and Epic #1047). termiHub installs these via a package manager (winget /
> Homebrew) or the user installs them, and runs them as separate processes;
> termiHub ships no X-server binary of its own (#1318).

See [`docs/licensing.md`](docs/licensing.md) for the process-boundary rationale
(why bundling these GPL/APSL programs does **not** change termiHub's own MIT
license) and the compliance checklist.

---

## Microsoft ConPTY host (Windows, bundled)

- **Component:** `conpty.dll` + `OpenConsole.exe` from the
  [`Microsoft.Windows.Console.ConPTY`](https://www.nuget.org/packages/Microsoft.Windows.Console.ConPTY)
  NuGet package
- **Version:** 1.24.261001001 — pinned, with SHA-256 checksums of the package and
  of both files, in `src-tauri/packaging/windows/conpty.env`
- **Upstream / source:** <https://github.com/microsoft/terminal>
- **License:** MIT, © Microsoft Corporation
- **License text:** [`licenses/MIT-microsoft-terminal.txt`](licenses/MIT-microsoft-terminal.txt)
- **How termiHub uses it:** The Windows installer ships both files, unmodified
  and Microsoft-signed, next to `termihub.exe` (#4121). Local terminals load this
  `conpty.dll`, which starts the bundled `OpenConsole.exe` as the console host,
  instead of the inbox Windows ConPTY, because the inbox host strips SIXEL and
  other inline-image sequences. The files are downloaded and checksum-verified at
  build time (`scripts/internal/fetch-conpty.sh`); they are not stored in this
  repository.

---

## Bundled fonts

The frontend bundle (`frontendDist`, so every installer) carries two vendored
font families. `pnpm notices:check` fails when a font file under `src/` or
`public/` has no license entry (#4357).

### Geist (UI typeface)

- **Component:** Geist variable font, `src/assets/fonts/Geist-Variable.woff2`
  (emitted as `assets/Geist-Variable-*.woff2`), #2673
- **Upstream / source:** <https://github.com/vercel/geist-font>
- **License:** SIL Open Font License 1.1 (OFL-1.1), © 2023 Vercel, in
  collaboration with basement.studio
- **License text:** [`licenses/OFL-1.1-geist.txt`](licenses/OFL-1.1-geist.txt)
  (the same text sits next to the font as `src/assets/fonts/Geist-OFL.txt`)

### MesloLGS Nerd Font Mono (terminal font)

- **Component:** `public/fonts/MesloLGSNerdFontMono-Regular.ttf` and
  `public/fonts/MesloLGSNerdFontMono-Bold.ttf` (copied to the bundle as
  `fonts/`), Nerd Fonts 3.3.0 build of Meslo LG S, #123
- **Upstream / source:** <https://github.com/ryanoasis/nerd-fonts> (v3.3.0);
  base font <https://github.com/andreberg/Meslo-Font>
- **Base font license:** Apache License 2.0, © 2009, 2010, 2013 André Berg —
  [`licenses/Apache-2.0-meslo-lg.txt`](licenses/Apache-2.0-meslo-lg.txt)
- **Nerd Fonts patcher and patched font:** MIT and OFL-1.1, © 2014 Ryan L
  McIntyre — [`licenses/nerd-fonts-LICENSE.txt`](licenses/nerd-fonts-LICENSE.txt)
- **Glyph sets merged in by the patcher** (from upstream `license-audit.md`):

  | Glyph set                 | License               | License text                                                                                                 |
  | ------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------ |
  | Codicons (Microsoft)      | CC-BY-4.0             | [`licenses/nerd-fonts-codicons-CC-BY-4.0.txt`](licenses/nerd-fonts-codicons-CC-BY-4.0.txt)                   |
  | Devicons                  | MIT                   | [`licenses/nerd-fonts-devicons-MIT.txt`](licenses/nerd-fonts-devicons-MIT.txt)                               |
  | Font Awesome (Fonticons)  | CC-BY-4.0 and OFL-1.1 | [`licenses/nerd-fonts-font-awesome.txt`](licenses/nerd-fonts-font-awesome.txt)                               |
  | Font Awesome Extension    | MIT                   | [`licenses/nerd-fonts-font-awesome-extension-MIT.txt`](licenses/nerd-fonts-font-awesome-extension-MIT.txt)   |
  | Font Logos                | Unlicense             | [`licenses/nerd-fonts-font-logos-Unlicense.txt`](licenses/nerd-fonts-font-logos-Unlicense.txt)               |
  | IEC Power Symbols         | MIT                   | [`licenses/nerd-fonts-iec-power-symbols-MIT.txt`](licenses/nerd-fonts-iec-power-symbols-MIT.txt)             |
  | Material Design Icons     | Apache-2.0            | [`licenses/nerd-fonts-material-design-icons.txt`](licenses/nerd-fonts-material-design-icons.txt)             |
  | Octicons (GitHub)         | MIT                   | [`licenses/nerd-fonts-octicons-MIT.txt`](licenses/nerd-fonts-octicons-MIT.txt)                               |
  | Pomicons                  | OFL-1.1               | [`licenses/nerd-fonts-pomicons-OFL-1.1.txt`](licenses/nerd-fonts-pomicons-OFL-1.1.txt)                       |
  | Powerline Extra Symbols   | MIT                   | [`licenses/nerd-fonts-powerline-extra-symbols-MIT.txt`](licenses/nerd-fonts-powerline-extra-symbols-MIT.txt) |
  | Powerline Symbols         | MIT                   | [`licenses/nerd-fonts-powerline-symbols-MIT.txt`](licenses/nerd-fonts-powerline-symbols-MIT.txt)             |
  | Seti-UI (Original Source) | MIT                   | [`licenses/nerd-fonts-seti-ui-MIT.txt`](licenses/nerd-fonts-seti-ui-MIT.txt)                                 |
  | Weather Icons             | OFL-1.1               | [`licenses/nerd-fonts-weather-icons-OFL-1.1.txt`](licenses/nerd-fonts-weather-icons-OFL-1.1.txt)             |

  The license texts are the upstream files from the Nerd Fonts 3.3.0
  `src/glyphs/` folders, or, where that folder has none, the glyph project's
  own repository license.

---

## VcXsrv (Windows X server)

- **Component:** VcXsrv Windows X Server
- **Version:** whatever the winget package `marha.VcXsrv` currently installs
  (termiHub no longer pins or bundles a specific build — #1318).
- **Upstream / corresponding source:** <https://github.com/marchaesen/vcxsrv>.
  Releases are also mirrored at <https://sourceforge.net/projects/vcxsrv/>.
- **License:** GNU General Public License, version 3.0 (GPL-3.0-or-later),
  with X.Org components under the MIT/X11 license.
- **License text:** [`licenses/GPL-3.0.txt`](licenses/GPL-3.0.txt) (retained for
  reference)
- **How termiHub uses it:** On Windows, termiHub **installs VcXsrv via winget**
  (`winget install -e --id marha.VcXsrv …`) — or the user installs it manually —
  and then launches the installed `vcxsrv.exe` as a **separate process** to
  provide a local X server for SSH X11 forwarding (#1318). termiHub does **not**
  host, redistribute, or link against VcXsrv; winget (or the user) fetches it from
  upstream.

> **Note (#1318).** termiHub no longer redistributes or hosts a VcXsrv binary, so
> the GPL-3.0 redistribution obligations (source offer for a pinned build) do not
> apply to termiHub's distribution — VcXsrv is obtained via winget. This entry is
> retained for attribution; the full licensing reconciliation is tracked in #1056.

### Corresponding source (GPL-3.0) — for reference

Because termiHub does not redistribute a VcXsrv binary (as of #1318), no written
source offer is required from termiHub. The complete corresponding source for any
VcXsrv version remains publicly available, at no charge, from the upstream
repository above at the matching release tag.

The winget install command termiHub runs is defined by
`WINGET_INSTALL_VCXSRV_COMMAND` in `src-tauri/src/terminal/xserver/types.rs`
(package id `marha.VcXsrv`).

---

## XQuartz (macOS X server)

- **Component:** XQuartz (X.Org server for macOS)
- **Upstream:** <https://www.xquartz.org/> · source:
  <https://github.com/XQuartz/XQuartz>
- **License:** MIT/X11 (X.Org components) and the
  [Apple Public Source License 2.0](licenses/APSL-2.0.txt) (Apple-authored
  components).
- **License text:** [`licenses/APSL-2.0.txt`](licenses/APSL-2.0.txt); the
  MIT/X11 terms are reproduced by X.Org upstream.
- **How termiHub uses it:** On macOS, termiHub does **not** redistribute or host
  XQuartz. It only _detects_ an existing install and, if absent, **guides** the
  user to install it via Homebrew (`brew install --cask xquartz`), a downloaded
  notarized Apple `.pkg`, or a deep link to xquartz.org. Because no XQuartz
  binary is shipped by termiHub, this entry is provided as attribution and a
  pointer to the authoritative license texts.

---

## Maintenance

When a bundled font is added, replaced or upgraded (a new Nerd Fonts release can
add glyph sets), add or refresh its license texts under `licenses/`, its entry
in `EXTERNAL_TEXTS` (`scripts/internal/third-party-notices.mjs`, listing the
font files in `fonts`) and the section above.

When the pinned ConPTY version changes, update the version above together with
the pins in `src-tauri/packaging/windows/conpty.env` (that file lists the steps).

When the install command or upstream source for any X server changes:

1. Update `WINGET_INSTALL_VCXSRV_COMMAND` in
   `src-tauri/src/terminal/xserver/types.rs` (the single source of truth for the
   winget invocation).
2. Update the corresponding entry and source link in this file to match.
3. If the upstream license changed, refresh the text under `licenses/`.
4. Re-run the compliance checklist in [`docs/licensing.md`](docs/licensing.md).

The generated `THIRD_PARTY_NOTICES.txt` needs no manual upkeep: it is rebuilt
from the lockfiles on every release. See
[`docs/licensing.md`](docs/licensing.md#generated-third-party-notices) for the
regeneration command.

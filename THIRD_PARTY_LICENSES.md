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
2. **External programs — this file.** The sections below document third-party
   programs that termiHub **installs and invokes** (but does **not** bundle or
   redistribute), together with their license texts and upstream source
   pointers. This content is also copied into the generated notices.

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

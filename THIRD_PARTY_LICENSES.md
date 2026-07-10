# Third-Party Licenses

termiHub itself is licensed under the [MIT License](LICENSE).

This file documents third-party software that termiHub **redistributes or hosts
for download**, together with the required license texts and source offers. It
is the canonical attribution surface referenced from the in-app **About → Open
Source Licenses** entry.

> **Scope note.** This file covers redistributed/hosted _binary artifacts_ whose
> licenses impose attribution or source-availability obligations — today, the X
> servers used for SSH X11 forwarding (see the
> [X server provisioning concept](docs/concepts/backlog/x-server-provisioning.html)
> and Epic #1047). Ordinary build-time Rust crates and npm packages are covered
> by their own license metadata in `Cargo.toml` / `package.json` and are not
> redistributed as standalone binaries by termiHub.

See [`docs/licensing.md`](docs/licensing.md) for the process-boundary rationale
(why bundling these GPL/APSL programs does **not** change termiHub's own MIT
license) and the compliance checklist.

---

## VcXsrv (Windows X server)

- **Component:** VcXsrv Windows X Server
- **Pinned version:** 21.1.13
- **Upstream / corresponding source:** <https://github.com/marchaesen/vcxsrv>
  (release tag `21.1.13`). Historical releases are also mirrored at
  <https://sourceforge.net/projects/vcxsrv/>.
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
> the GPL-3.0 redistribution obligations below (source offer for a pinned build)
> no longer apply to termiHub's distribution — VcXsrv is now obtained via winget.
> This entry is retained for reference; the full licensing reconciliation is
> tracked in #1056.

### Written offer for corresponding source (GPL-3.0 §6) — historical

_No longer applicable: termiHub does not redistribute a VcXsrv binary as of #1318._
The complete corresponding source for any VcXsrv version remains publicly
available, at no charge, from the upstream repository above at the matching
release tag.

The pinned version string above **must** match `PINNED_VCXSRV.version` in
`src-tauri/src/terminal/xserver/acquire.rs`; the download URL and SHA-256 for
the hosted artifact live in that same pinned table.

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

When the pinned version of any hosted X-server artifact changes:

1. Update the pinned table in `src-tauri/src/terminal/xserver/acquire.rs`.
2. Update the corresponding **Pinned version** and source link/tag in this file.
3. If the upstream license changed, refresh the text under `licenses/`.
4. Re-run the compliance checklist in [`docs/licensing.md`](docs/licensing.md).

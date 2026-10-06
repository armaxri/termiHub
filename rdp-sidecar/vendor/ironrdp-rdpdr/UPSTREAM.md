# Upstreaming the drive PreferredDosName fix

Prepared upstream text for [Devolutions/IronRDP](https://github.com/Devolutions/IronRDP), so the
fork can be retired (termiHub #4125). Nothing has been submitted yet: a maintainer posts it (see
[How to submit](#how-to-submit)).

- **Base:** upstream `ironrdp-rdpdr` `0.7.0`, tag `ironrdp-rdpdr-v0.7.0`, commit
  `11a0810cfbbabd8b8023875a05e3041216d4b01b`.
- **Upstream state (checked 2026-10-06, master `38b074e4befe`):** the bug is already fixed on
  master, unreleased. `PreferredDosName::for_drive` arrived in
  [`161409e18dd1`](https://github.com/Devolutions/IronRDP/commit/161409e18dd185de9bb30730303e56f5e8d28941)
  ("feat(rdpdr): add filesystem PDU foundation", IronRDP#1566, merged 2026-08-07), with the test
  `filesystem_drive_announce_encodes_unicode_data_and_valid_dos_name`. The newest release,
  `ironrdp-rdpdr` 0.7.0 (2026-07-10), still sends `ignored`. No issue or pull request names the
  xrdp symptom.
- **Complication:** the same upstream commit changed the drive `DeviceData` from UTF-8 to
  UTF-16LE. [IronRDP#2075](https://github.com/Devolutions/IronRDP/issues/2075) (open, 2026-10-04)
  reports that Windows then exposes a drive named `RDPILOT` only as `\\tsclient\R`, and that
  UTF-8 restores the full name. So a plain upgrade to the next release could fix xrdp and break
  Windows. The fork takes only `for_drive` and keeps 0.7.0's UTF-8 `DeviceData`.
- **Verified:** with the fork, xrdp 0.10 (termiHub's `rdp-server` fixture) mounts a drive
  announced as `th12345` at `~/thinclient_drives/th12345` (termiHub `core/tests/rdp.rs`, RDP-15).
  The patch below applies cleanly to the 0.7.0 package (`git apply --check`).

The best upstream outcome is a release that has `for_drive` and a `DeviceData` encoding that
works on Windows. The text below asks for that and adds the xrdp data point to #2075, so the
two are fixed together.

## Suggested comment on IronRDP#2075

> An xrdp data point for this, from a client built on IronRDP 0.17 / `ironrdp-rdpdr` 0.7.0.
>
> xrdp's devredir (0.10) names a redirected drive only from the 8-byte `PreferredDosName` and
> does not read `DeviceData`. In 0.7.0 `DeviceAnnounceHeader::new_drive` puts the literal
> `ignored` there, so every drive is mounted as `~/thinclient_drives/ignored` on xrdp (chansrv
> logs `Detected remote drive 'ignored'`). `PreferredDosName::for_drive` from #1566 fixes that
> on master, but it is not released yet.
>
> We carry a patch on 0.7.0 that takes only `for_drive` and keeps `DeviceData` as null-terminated
> UTF-8. With it, xrdp mounts the drive under its (7-character) name, and the drive keeps its
> full name on Windows, which matches what you found here. If UTF-8 `DeviceData` comes back for
> Windows, please keep `for_drive` for `PreferredDosName`: xrdp depends on it.
>
> Could the fix for this issue and `for_drive` go out in the next `ironrdp-rdpdr` release?

## Suggested issue (only if #2075 is closed or the comment gets no answer)

**Title:** `rdpdr: drives are named "ignored" on xrdp with ironrdp-rdpdr 0.7.0`

**Body:**

> `ironrdp-rdpdr` 0.7.0 announces every redirected drive with `PreferredDosName` = `ignored`
> (`DeviceAnnounceHeader::new_drive` in `src/pdu/efs.rs`) and the real name in `DeviceData`.
> MS-RDPEFS 2.2.1.3 says the drive name MUST be in `PreferredDosName`, truncated to fit; a
> server may then prefer `DeviceData`. xrdp's devredir reads only `PreferredDosName`, so on an
> xrdp host every drive appears as `~/thinclient_drives/ignored`, and two drives collide.
> FreeRDP fills both fields, so its drives keep their names on xrdp.
>
> **Reproduction:** connect any IronRDP 0.17 client that announces a drive named `share`
> (`Rdpdr::with_drives(Some(vec![(1, "share".into())]))`) to xrdp 0.10 (xorgxrdp session) and
> run `ls ~/thinclient_drives` in the session: it prints `ignored` instead of `share`.
>
> master already fixes this with `PreferredDosName::for_drive` (#1566). Could it be released,
> for example as a 0.7.x patch release? The patch below is that function applied to 0.7.0
> without the other changes in #1566 (in particular it keeps the UTF-8 `DeviceData` that
> Windows needs, see #2075).

## The patch

Against `ironrdp-rdpdr-v0.7.0` (for a 0.7.x backport branch). It is the fork's code delta without
the termiHub `termiHub fork delta (#4125)` markers and the fork's unit tests (upstream master
already has a test for `for_drive`). The vendored copy's other differences from the crates.io
package are packaging only and are **not** part of the submission (see `README.md`).

```diff
--- a/crates/ironrdp-rdpdr/src/pdu/efs.rs
+++ b/crates/ironrdp-rdpdr/src/pdu/efs.rs
@@ -1031,6 +1031,8 @@
     }

     fn new_drive(device_id: u32, name: String) -> Self {
+        let preferred_dos_name = PreferredDosName::for_drive(&name);
+
         // The spec says Unicode but empirically this wants null terminated UTF-8.
         let mut device_data = name.into_bytes();
         device_data.push(0u8);
@@ -1044,7 +1046,8 @@
             // is ignored."
             //
             // Since we do support DRIVE_CAPABILITY_VERSION_02, we'll put the full name in the DeviceData field.
-            preferred_dos_name: PreferredDosName("ignored".to_owned()),
+            // Servers that read only PreferredDosName (e.g. xrdp) still need the truncated name there.
+            preferred_dos_name,
             device_data,
         }
     }
@@ -1208,6 +1211,30 @@
 struct PreferredDosName(String);

 impl PreferredDosName {
+    fn for_drive(name: &str) -> Self {
+        let mut preferred = String::with_capacity(7);
+        for ch in name.chars() {
+            if ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '_' | '-' | '.') {
+                preferred.push(ch);
+            } else if ch == ':' && preferred.len() < 7 {
+                preferred.push(ch);
+                break;
+            } else {
+                break;
+            }
+
+            if preferred.len() == 7 {
+                break;
+            }
+        }
+
+        if preferred.is_empty() {
+            preferred.push_str("DRIVE");
+        }
+
+        Self(preferred)
+    }
+
     fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
         write_string_to_cursor(dst, &self.format(), CharacterSet::Ansi, false)
     }
```

## How to submit

1. Check that IronRDP#2075 is still open and that no `ironrdp-rdpdr` release after 0.7.0 exists.
   If a release now contains `for_drive`, skip to [Retiring the fork](#retiring-the-fork).
2. Post the comment above on IronRDP#2075. Open the separate issue only if #2075 has been closed
   without a release that fixes both, or the comment gets no answer for a few weeks.
3. If maintainers ask for a backport pull request: branch from tag `ironrdp-rdpdr-v0.7.0`, save
   the diff above as `drive-dos-name.patch`, apply it with `git apply drive-dos-name.patch`, and
   run `cargo test -p ironrdp-rdpdr` and `cargo fmt --check`.
4. Record the links in `vendor/vendored-forks.json` (the delta's `refs`), in
   `docs/supply-chain.md` → "Upstreaming status", and on termiHub #4125.

## Retiring the fork

Once an `ironrdp-rdpdr` release contains `for_drive`:

1. Check that release's drive `DeviceData` encoding. If it is UTF-16LE and IronRDP#2075 is not
   fixed, Windows hosts would see the drive under its first letter only: keep the fork (re-based,
   with a `DeviceData` delta instead) until it is.
2. Otherwise remove the `ironrdp-rdpdr` entry from `[patch.crates-io]` in `rdp-sidecar/Cargo.toml`,
   bump `ironrdp` if that release needs a newer meta crate, and run
   `cargo update -p ironrdp-rdpdr` in `rdp-sidecar/`.
3. Delete `rdp-sidecar/vendor/ironrdp-rdpdr/`, its entry in `vendor/vendored-forks.json`, its rows
   in the "Vendored forks" and "Upstreaming status" tables of `docs/supply-chain.md`, and update
   the parser watchlist row.
4. Keep `drive_announce_carries_the_drive_name_in_preferred_dos_name` in `rdp-sidecar/src/rdp.rs`
   and RDP-15 in `core/tests/rdp.rs`: they then guard the upstream fix. Run RDP-15 against the
   Docker fixture before merging.

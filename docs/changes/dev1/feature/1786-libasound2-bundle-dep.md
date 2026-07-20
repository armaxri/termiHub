### Fixed

- Linux packages: the `.deb` and `.rpm` bundles now declare a runtime dependency
  on ALSA (`libasound2t64 | libasound2` for deb, `alsa-lib` for rpm), so the
  bundled RDP audio sidecar (`termihub-rdp-helper`, which dynamically links
  `libasound.so.2`) is guaranteed its shared library on minimal installs. The
  sidecar ships as a Tauri `externalBin`, which the deb autodetection does not
  scan, so the dependency has to be declared explicitly (#1786).

### Added

- RDP audio output redirection (`rdpsnd`) now works on **Linux**, so enabling
  "Redirect Audio Output" plays the remote session's sound locally on Linux as
  it already did on macOS and Windows. The sidecar's `rodio`/`cpal` audio
  backend, previously compiled only for macOS and Windows, now also builds for
  Linux against ALSA (`libasound.so.2`, present on every desktop Linux). On a
  host with no usable output device playback degrades to a silent no-op rather
  than failing the session (#1772).

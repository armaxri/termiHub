### Added

- RDP: audio output redirection. The remote session's audio can now be played on
  this computer over the audio channel (rdpsnd / MS-RDPEAUDIO) in the IronRDP
  sidecar. The sidecar advertises a PCM format, decodes the server's audio
  stream, and plays it through a host output device — decode and playback stay
  inside the sidecar process. Redirection is **off by default** and opt-in per
  connection via the new "Redirect Audio Output" option. Audible playback is
  available on macOS and Windows; Linux support is planned (#1764).

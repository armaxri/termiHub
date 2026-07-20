### Added

- RDP audio (`rdpsnd`) now negotiates **multiple PCM formats** instead of a
  single fixed one. The sidecar advertises a table of common sample rates
  (48/44.1/22.05/11.025 kHz) in both mono and stereo (16-bit PCM) and plays each
  audio buffer at exactly the rate and channel count the server selected, so
  audio from servers that stream at a non-CD rate is no longer forced through a
  single 44.1 kHz stereo assumption (#1773).

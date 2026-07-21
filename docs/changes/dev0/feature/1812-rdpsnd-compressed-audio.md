### Added

- RDP audio redirection now plays **compressed** `rdpsnd` streams in addition to
  PCM: an RDP server that offers **MS-ADPCM** (`WAVE_FORMAT_ADPCM`) or **IMA/DVI
  ADPCM** (`WAVE_FORMAT_DVI_ADPCM`) has that format negotiated and decoded to
  16-bit PCM before playback, at the format's own sample rate and channel count
  (so the multi-rate "chipmunk audio" guard from #1773 still holds). Decoding uses
  the pure-Rust Symphonia ADPCM codec, target-gated to macOS/Windows/Linux like
  the rest of the sidecar audio path and adding no native build dependency. Opus
  (`WAVE_FORMAT_OPUS`) remains unsupported for now — its decoders link the native
  `libopus` C library — and is tracked as a follow-up (#1812).

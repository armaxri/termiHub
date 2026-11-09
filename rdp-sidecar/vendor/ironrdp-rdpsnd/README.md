# IronRDP RDPSND (termiHub vendored fork)

## termiHub vendored fork

This is a vendored fork of `ironrdp-rdpsnd` **0.11.0** for termiHub's RDP sidecar. It was
first forked from 0.9.0 for [`termiHub#1773`](https://github.com/armaxri/termiHub/issues/1773)
and re-based onto 0.11.0 for [`termiHub#5117`](https://github.com/armaxri/termiHub/issues/5117).
It is patched into the workspace-excluded `rdp-sidecar` crate via `[patch.crates-io]`.

**Fork base:** upstream tag `ironrdp-rdpsnd-v0.11.0`, commit
[`b13befa0db86f48f523a0b2b007e399f9811e0ec`](https://github.com/Devolutions/IronRDP/commit/b13befa0db86f48f523a0b2b007e399f9811e0ec)
of [IronRDP](https://github.com/Devolutions/IronRDP), copied from the crates.io package
(without its registry-only `.cargo_vcs_info.json`, `Cargo.lock` and `Cargo.toml.orig`). The
fork is registered in [`vendor/vendored-forks.json`](../../../vendor/vendored-forks.json), and
a weekly CI job reports upstream releases, commits and advisories that the fork does not have
yet. See `docs/supply-chain.md` → "Vendored forks". Update both when re-basing or reviewing
upstream again.

### The one change: the Training Confirm echoes wPackSize ([#4923])

A port of upstream
[`f86e3c49`](https://github.com/Devolutions/IronRDP/commit/f86e3c49f349127b7e7f3c737ca10de49cc20f8d)
("fix(rdpsnd): echo the server's wPackSize in the Training Confirm", IronRDP#2294), which
landed on master after the 0.11.0 release and is not released yet. The Training Confirm must
echo the Training PDU's `wPackSize`, the size of the whole PDU (MS-RDPEA 2.2.3.2); 0.11.0 sends
the data length, 8 bytes short, which GNOME Remote Desktop rejects, and it then sends no audio.
`TrainingPdu::pack_size()` (`src/pdu/mod.rs`) computes the value for both the encoder and
`training_confirm` (`src/client.rs`). The `crates/ironrdp-rdpsnd` part of the commit is applied
as is and marked `termiHub fork (#5117)`. This crate builds with `test = false`; the test is
`training_confirm_echoes_the_servers_pack_size` in the sidecar's `src/rdpsnd_fork_tests.rs`.

Drop the fork once an `ironrdp-rdpsnd` release containing `f86e3c49` is adopted.

### Re-base onto 0.11.0 ([#5117])

Upstream 0.10.0 took over, or replaced, everything else the 0.9.0 fork carried:

- **`wave` receives the negotiated `AudioFormat`** ([#1773]): upstream `2d9a9bf1` made the same
  change to `RdpsndClientHandler::wave`, and `wFormatNo` resolves against the list the client
  advertised.
- **Server-chosen compressed formats** ([#1812]): the fork's `accepts_format` hook is replaced by
  upstream's `RdpsndClientHandler::choose_formats` (`45b67591`), followed by
  `pdu::retain_offered`. The sidecar's handler (`rdp-sidecar/src/audio.rs`) returns the
  server's playable formats in the server's order, verbatim, so the advertised list and the
  formats `wave` receives are the same as with the fork. Tests:
  `audio::tests::choose_playable_echoes_playable_server_formats_in_server_order` and
  `audio::tests::rdpsnd_advertises_the_chosen_formats_verbatim`.
- **Malformed PDUs are dropped, CryptKey/WaveEncrypt keep the channel alive, pre-v8 WaveInfo +
  Wave playback** ([#3499], [#3510]): upstream `c87ab68e` and `2d9a9bf1`.

The sidecar's `src/rdpsnd_fork_tests.rs` keeps guarding all of them, now as regression tests of
upstream behaviour.

Not used by the sidecar: the `AUDIO_PLAYBACK_DVC` / `AUDIO_PLAYBACK_LOSSY_DVC` processor
`RdpsndDvc`, the codecs and the jitter buffer (`45b67591`). The sidecar registers the static
`RDPSND` channel only and keeps its own ADPCM decoder and jitter buffer. Without a clock
(`Rdpsnd::with_clock`) and with the default zero `playback_latency`, Wave Confirms still carry
the server's timestamp.

### Upstream review

Reviewed upstream `crates/ironrdp-rdpsnd` up to IronRDP
[`d5e70f02`](https://github.com/Devolutions/IronRDP/commit/d5e70f02b670dbe79ad7ef47203bfa82d32c16f4)
(2026-11-09): `f86e3c49` is the only commit after 0.11.0.

Everything else is byte-for-byte upstream 0.11.0.

[#1773]: https://github.com/armaxri/termiHub/issues/1773
[#1812]: https://github.com/armaxri/termiHub/issues/1812
[#3499]: https://github.com/armaxri/termiHub/issues/3499
[#3510]: https://github.com/armaxri/termiHub/issues/3510
[#4923]: https://github.com/armaxri/termiHub/issues/4923
[#5117]: https://github.com/armaxri/termiHub/issues/5117

---


Audio output channels implemented as described in [MS-RDPEA]: the static `RDPSND` channel, and the
`AUDIO_PLAYBACK_DVC` and `AUDIO_PLAYBACK_LOSSY_DVC` dynamic channels that Windows 8 and later
servers prefer and route over the UDP transport when one is up.

This crate is part of the [IronRDP] project.

[IronRDP]: https://github.com/Devolutions/IronRDP
[MS-RDPEA]: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpea/bea2d5cf-e3b9-4419-92e5-0e074ff9bc5b

The client processors share one protocol core and drive an `RdpsndClientHandler`, which picks the
formats to advertise from the server's list and plays the wave data:

- `Rdpsnd` serves the static channel, including the pre-v8 WaveInfo / bare Wave two-message path and
  the legacy UDP datagrams (`SNDUDPWAVE` / `SNDUDPWAVELAST`, signature-checked) for a caller-owned
  socket. Wave Encrypt PDUs are not decrypted.
- `RdpsndDvcState` serves both dynamic channels: Windows negotiates on `AUDIO_PLAYBACK_DVC` and sends
  AAC wave data on `AUDIO_PLAYBACK_LOSSY_DVC`, so the two channels share the negotiated state.
- Wave Confirm PDUs report the server timestamp plus the time the client held the block plus the
  handler's playback latency, measured with a caller-supplied clock.

The crate performs no I/O. It also provides:

- `codec`: decoders and encoders for PCM, G.711 A-law and µ-law, IMA ADPCM and Microsoft ADPCM;
- `playout`: a jitter-buffer policy that keeps a latency target, rebuffers after underruns, absorbs
  clock drift and discards backlogs.

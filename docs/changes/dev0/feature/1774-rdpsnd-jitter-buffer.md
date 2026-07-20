### Changed

- RDP audio output (`rdpsnd`) now plays through a bounded jitter / latency
  buffer. A small target-latency cushion is buffered ahead of playback (and
  rebuilt after any underrun) so late or bursty audio frames no longer cause
  audible dropouts on a lossy connection, while a hard latency cap tail-drops
  buffers once the queue would grow too deep — so a chatty server can no longer
  grow playback delay or memory without bound. Audio stays in the negotiated PCM
  format with no resampling (#1774).

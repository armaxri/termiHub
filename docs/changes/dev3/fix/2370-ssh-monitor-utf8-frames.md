### Fixed

- Remote SSH host monitoring no longer silently drops output when a multi-byte
  UTF-8 character straddles two SSH data frames. The agent's monitoring
  collector decoded each `ChannelMsg::Data` frame independently, so a frame that
  ended mid-character was not valid UTF-8 on its own and the entire frame was
  discarded — corrupting or truncating the stats sample (a failed monitoring
  cycle, or garbled hostname/OS fields) with no error surfaced. The raw frames
  are now concatenated before decoding, and any genuinely invalid bytes are
  decoded lossily rather than dropping a whole frame (#2370).

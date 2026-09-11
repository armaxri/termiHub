### Fixed

- Traceroute now correlates each ICMP reply to the exact probe that triggered
  it, so unrelated ICMP traffic on a busy host (another traceroute or ping, a
  stray Time Exceeded) can no longer be misattributed to the wrong hop and
  produce bogus router mappings or round-trip times. Each probe is sent to a
  unique destination port and the reply is matched against the original
  datagram quoted inside the ICMP error, for both IPv4 and IPv6.
- RDP clipboard file download can no longer hang on a misbehaving or hostile
  remote. A stream of empty, non-final chunks previously made no progress yet
  never ended; the fetch now rejects an empty non-final chunk and bounds the
  total number of chunks, so the transfer always makes forward progress or
  fails cleanly.

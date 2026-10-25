### Changed

- Network Tools: **Traceroute runs without root on Linux.** When the app cannot
  open a raw ICMP socket, it now traces through the kernel's ICMP error queue on
  its ordinary UDP probe socket (`IP_RECVERR`, the `tracepath` method) instead of
  failing with "insufficient privileges". macOS and Windows behave as before
  (#4964).

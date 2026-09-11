### Security

- The embedded TFTP server now enforces the RFC 1350 transfer-ID (TID) binding:
  once a transfer has started, DATA/ACK datagrams are only accepted from the peer
  that began it. A datagram from any other source is answered with a TFTP ERROR
  ("unknown transfer ID") and dropped, so a third party can no longer inject or
  hijack an in-flight upload or download. This applies to both agent-hosted and
  desktop-hosted TFTP servers (CORE-024).

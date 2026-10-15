### Fixed

- A remote agent no longer queues more than its 512 KiB output window for a persistent session whose connection stalls right after it reattaches; output read before the reattaching agent finished its handshake used to go out unbounded (#4768).

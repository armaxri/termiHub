### Fixed

- Remote agent sessions now cap how much output can pile up on the agent before a desktop pause takes effect: each session holds at most 512 KiB queued for the connection, then stops reading until it drains, so a fast program on a high-latency link no longer queues tens of MiB. Other sessions and control messages are unaffected (#4439).

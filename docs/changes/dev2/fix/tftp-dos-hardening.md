### Security

- The embedded TFTP server (which can also be agent-hosted and is unauthenticated
  by design) is now hardened against two unauthenticated denial-of-service
  vectors. Uploads (WRQ) are streamed straight to disk instead of being buffered
  whole in memory, and both uploads and downloads (RRQ) are bounded by a
  configurable maximum transfer size (default 100 MiB) — a transfer that exceeds
  the cap is aborted with a TFTP error and any partial upload is discarded, so a
  client can no longer OOM or fill the host with one oversized transfer
  (CORE-021). The maximum size is configurable per server via the new
  `maxTransferBytes` setting. Concurrent transfers are now capped (64 at a time),
  so a flood of requests can no longer spawn threads without bound (CORE-022).

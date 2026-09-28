### Security

- The desktop now **verifies the agent binary's Ed25519 release signature itself** before
  deploying it to a remote host, on every path: the immediate shutdown + install over SSH,
  the Windows fallback, and the coordinated update push. A release build refuses an agent
  binary whose `.sig` is missing, malformed, or does not verify — whether it came from the
  local cache, the app bundle, or a GitHub download — and fails closed while no release key
  is configured. The desktop and the agent share one implementation and one compiled-in key
  (AGT-005, #3330).

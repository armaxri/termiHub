### Security

- Remote-agent self-updates are now **cryptographically authenticated**. A release-built
  agent only swaps in a new binary when it carries a valid Ed25519 signature from the
  termiHub release key, whose public half is compiled into the agent; the private key lives
  only in the release pipeline. This applies to every route — the agent's own GitHub
  self-update, the desktop's coordinated push, and "Apply Now" — and is checked again
  immediately before the swap, on top of the existing staging-path confinement and SHA-256
  integrity checks. Unsigned or badly signed updates are refused with a dedicated error
  (`-32021`) instead of being applied. Every release now publishes a `.sig` signature next
  to each agent binary and its `.sha256` checksum (AGT-005, #3213).

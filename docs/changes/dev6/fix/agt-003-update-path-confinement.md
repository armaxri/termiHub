### Security

- The remote agent now **confines the self-update binary to its own staging
  directory** (AGT-003). Previously `agent.request_update` /
  `agent.request_deferred_update` accepted an arbitrary absolute `binaryPath`
  validated only by an "is this a file" check, so any file readable by the agent
  user — at any path — could be swapped in as the agent binary and re-execed as
  the agent user. The agent now canonicalizes the requested path (resolving
  symlinks and `..`) and applies it only when it is contained within a trusted,
  agent-owned staging location: the self-update download directory
  (`<config>/updates`) or the desktop's coordinated-push upload path. Anything
  outside — an absolute path elsewhere, a `..` traversal, or a symlink that
  escapes staging — is refused, and the refusal is re-asserted at the moment of
  apply (defense-in-depth) so no copy or re-exec ever runs for an out-of-staging
  source. The check fails closed. Legitimate self-updates and desktop-pushed
  updates are unaffected. Cryptographic signature verification of the staged
  binary and a dedicated authorization step for the update RPCs remain planned
  follow-ups (AGT-005).

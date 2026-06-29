# Sync Ledger — SSH Jump Host

**Last synced:** never (concept not yet implemented)
**Status:** diverged (entirely missing — backlog feature)

This ledger is maintained by the `/sync-concept ssh-jump-host` skill. It records the last
commit at which the concept artifacts and the code were reconciled, plus any open divergences.

## Open divergences

| #   | Artifact claim               | Code reality              | Type    | Recommendation                                 |
| --- | ---------------------------- | ------------------------- | ------- | ---------------------------------------------- |
| 1   | Entire feature (per concept) | Not implemented — backlog | Missing | Implement per `concept.md` order, then re-sync |

## Notes

- 2026-06-29 (#872): Concept refined to match the real SSH stack — termiHub uses **russh 0.61**
  (async), not `ssh2`/libssh2. Backend impl details rewritten around `channel_open_direct_tcpip` +
  `channel.into_stream()` + `russh::client::connect_stream` (already used by the tunnel forwarders
  and SFTP/X11), the config field renamed to `proxy_jump` (OpenSSH `-J` style), and a concrete
  `SSH-JUMP-01` test-conversion plan added against the existing `ssh-jumphost-bastion` /
  `ssh-jumphost-target` Docker fixtures. No code yet — still a backlog concept.

## Resolved

| Date | #   | Resolution |
| ---- | --- | ---------- |
| —    | —   | —          |

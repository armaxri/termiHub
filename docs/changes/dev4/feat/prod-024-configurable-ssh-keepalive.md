### Added

- SSH connections now expose two optional advanced settings for tuning the
  SSH-level keepalive: **Keepalive Interval (s)** — how often a keepalive probe
  is sent on an idle connection — and **Max Missed Keepalives** — how many
  unanswered probes are tolerated before the link is considered lost. Both live
  in the Advanced section of the SSH connection form and are left empty by
  default, in which case termiHub uses the previous fixed values (30 s interval,
  3 missed probes). Existing saved connections are unchanged (PROD-024).

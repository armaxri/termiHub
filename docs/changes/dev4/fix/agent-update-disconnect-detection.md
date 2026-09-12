### Fixed

- Applying a staged agent self-update now reports success or failure correctly
  regardless of the transport's error-message wording or the host's locale
  (I18N-008). When an "Apply Now" swaps the agent binary, the expected transport
  drop is now identified from the agent's authoritative connection state (did the
  connection actually drop in the short window after the apply request?) rather
  than by substring-matching English words in the error text. This removes two
  wrong outcomes: a genuine update failure whose message merely mentioned
  "connection"/"closed" is no longer misreported as "update applied", and a truly
  expected disconnect surfaced under a non-English transport/OS locale is no
  longer misreported as a hard failure.

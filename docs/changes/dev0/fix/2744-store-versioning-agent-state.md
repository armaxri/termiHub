### Fixed

- The remote agent's session state file (`state.json`) is now downgrade-safe
  (#2744). A `state.json` written by a newer agent is never overwritten by an
  older one after a rollback: it is left intact and every save over it is
  refused. A file that is valid JSON but has one malformed part (for example a
  single bad session) is backed up and salvaged — the well-formed sessions, the
  pending-update record and unknown fields are kept — instead of the whole
  recovery map being dropped. If a corrupt file cannot be backed up, the agent
  no longer overwrites it.

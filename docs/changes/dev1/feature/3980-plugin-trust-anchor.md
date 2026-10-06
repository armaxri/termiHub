### Added

- Plugin trust can now be anchored in a first-party publisher key compiled into the
  app. Once the termiHub key is configured, first-party plugins signed with it verify
  without a trust prompt, and the entry cannot be removed or replaced through
  `trust-store.json`. Until then, plugin publisher trust stays trust-on-first-use, as
  before (#3980).

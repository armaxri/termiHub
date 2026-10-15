### Security

- Connections: removing a jump-host hop, or changing its host, username or port, now also deletes
  the saved password of the old hop from the credential store instead of leaving it there for good.
  Saving while the credential store is locked deletes it on the next unlock, and passwords left
  behind by earlier versions are cleaned up the first time the store is unlocked (#4792).

### Security

- The remote agent (and other headless SSH paths with no interactive UI) no
  longer silently accepts an unknown or changed server host key. Where #1959
  still accepted-with-warning when no host-key prompt was available, the default
  is now strict: only a key already recorded in the agent host's
  `~/.ssh/known_hosts` is trusted, and an unknown or changed key is refused with
  a clear log message rather than blindly accepted. On the desktop, a host key
  that is *changed* relative to `~/.ssh/known_hosts` (but never seen by
  termiHub's own trust store) now raises the changed-key man-in-the-middle
  warning instead of a first-contact prompt, so a changed key is never quietly
  accepted anywhere (#1969).

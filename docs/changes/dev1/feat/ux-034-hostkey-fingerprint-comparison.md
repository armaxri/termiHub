### Changed

- The SSH host-key trust prompt now shows the **previously-trusted fingerprint
  beside the new one** when a remembered host presents a _changed_ key — the
  possible man-in-the-middle case. Both are clearly labeled ("Previously
  trusted" vs "New") and individually copyable, so you can compare exactly what
  changed before deciding whether to trust it. First-contact prompts for an
  unknown host are unchanged (they show only the presented fingerprint, since
  there is no prior key to compare against).

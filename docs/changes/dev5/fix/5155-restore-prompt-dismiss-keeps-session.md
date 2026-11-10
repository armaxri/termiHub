### Fixed

- Session restore: pressing Escape or clicking outside the "Restore Previous Session?" prompt no
  longer deletes the saved session. It now just closes the prompt, ignores "Remember my choice",
  and asks again on the next launch. Choosing "Start Fresh" also keeps the saved session until
  your new layout is saved over it, so a crash right after Start Fresh no longer loses it
  (#5155).

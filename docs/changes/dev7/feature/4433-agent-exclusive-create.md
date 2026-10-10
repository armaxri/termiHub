### Fixed

- Dropping a file onto a remote desktop routed through an agent no longer
  overwrites a file of the same name that appears on the agent host between the
  name check and the upload. The upload claims its name first and moves on to
  "name (1)" when the name is taken. This needs an agent with protocol 0.30.0
  or newer; with an older agent the name check alone applies, as before
  (#4433).

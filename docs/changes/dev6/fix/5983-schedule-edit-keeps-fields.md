### Fixed

- **Editing a schedule no longer loses settings** (#5983): changing anything in the schedule editor
  cleared the description and turned "Connect if not connected" off. Every field you do not change
  is now kept as it was. A rename also no longer restarts the timing of a weekly schedule or
  disables one whose targets were stored in an unusual form, and settings written by a newer
  termiHub version survive an edit, an enable or a run.

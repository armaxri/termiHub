### Fixed

- File transfers: a transfer whose background task crashed unexpectedly no longer
  stays stuck as queued or in progress in the Transfer Queue, and no longer
  blocks every later transfer on the same session. It now settles as failed
  with a "transfer task crashed" message and frees its slot for the next queued
  transfer (#4671).

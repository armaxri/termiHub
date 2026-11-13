### Fixed

- A download interrupted by a crash now resumes from its last checkpoint after
  the relaunch. The partial file usually held a little more than the
  checkpoint, and termiHub treated that as a file it had not written and
  downloaded the whole file again from the start.

### Fixed

- Importing a workflow file with a malformed `while` condition on a loop step now
  names the step as a loop step in the error message, instead of calling it a
  conditional step (#4386).

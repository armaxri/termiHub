### Security

- **Which local program an automation may start is now decided by the backend, when it starts** (#5994),
  for every kind of run. Only the interface checked the list of allowed programs before. The program is
  resolved to one file, that file must be allowed, and exactly that file is started. A name that does
  not plainly name one program is refused, and a bare name is no longer found in the working directory.
- "Run a local program?" shows the file that would start, and "Always allow" remembers that file, so a
  different program of the same name is asked about again. Programs you allowed before keep working.
- A program that was not started now says why and where to allow it, instead of an exit code.

### Changed

- On Windows a program name without an extension starts an `.exe` found on `PATH`, no longer one that is
  only in termiHub's own folder.

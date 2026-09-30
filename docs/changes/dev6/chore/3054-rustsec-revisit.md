### Security

- Dependencies: bumped the transitive `event-listener` from 5.4.1 to 5.4.2 to
  resolve the `RUSTSEC-2026-0221` unsoundness notice, and dropped its accepted
  ignore. Lockfile-only change (#3054).

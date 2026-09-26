## Changed

- Native plugin log lines (ABI 1.1 host log callback) are now rate-limited per plugin — a burst of 100 lines, then 20 lines per second. Excess lines are dropped and reported by a single "N log lines suppressed" warning, so a plugin logging in a loop can no longer flood the Log Viewer or grow the log file unbounded.

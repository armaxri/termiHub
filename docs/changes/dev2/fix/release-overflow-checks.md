### Changed

- Release (shipping) builds now enable integer overflow checks, matching what
  debug and test builds already do. Previously Cargo's default release profile
  left `overflow-checks` off, so an integer `+`/`-`/`*` that would panic in tests
  could silently wrap to a wrong value in the released binary. For a
  safety-critical app a fail-fast panic on an arithmetic bug is preferable to
  silently continuing with a corrupt value, so overflow now aborts the operation
  instead of wrapping. Arithmetic that is *meant* to wrap (protocol counters,
  backoff/hash math) already uses explicit `wrapping_*`/`saturating_*`/`checked_*`
  and is unaffected. The runtime cost is negligible for a terminal hub (ERR-010).

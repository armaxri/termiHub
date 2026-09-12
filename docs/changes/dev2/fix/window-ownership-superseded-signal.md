### Fixed

- When two windows render the same session and the second one claims it, the
  window that loses ownership now shows a notice ("This session is now controlled
  by another window — resize is disabled here") instead of leaving a terminal
  that silently refuses to resize. Session ownership is single-owner by design —
  the owning window drives the PTY size — but the loser previously got no signal,
  so the disabled resize looked like an unexplained bug. The transition is now
  surfaced to the affected window (SM-026).

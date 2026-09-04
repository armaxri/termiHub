### Fixed

- Connecting spinner no longer freezes for users with "reduce motion" enabled.
  The connection overlay's spinner is the sole "work in progress" cue, but the
  global reduced-motion backstop collapsed every animation to a single frame,
  leaving the spinner static (reading as a hung connection). Loading spinners
  can now opt into essential motion: they spin normally, and under reduced
  motion they degrade to a gentle opacity pulse instead of freezing, so the
  progress signal stays alive without the rotation reduce-motion users avoid
  (#2601).

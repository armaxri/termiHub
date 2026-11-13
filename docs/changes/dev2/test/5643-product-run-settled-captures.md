### Internal

- Product-run window captures now wait for a settled screen before they are
  taken: no visible lazy-load spinner or skeleton, the expected form visible,
  fonts loaded and two idle animation frames, read from the new
  `renderSettled` test-bridge query. A screen that never settles fails the step
  with the reason instead of capturing a spinner for the UI review (#5643).

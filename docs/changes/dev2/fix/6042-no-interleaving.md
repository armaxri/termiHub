### Fixed

- An automation that types keys and a step-by-step one could run in the same terminal at the same time,
  their keys mixed. Starting one where the other kind runs now asks first, naming it, and stops it
  in that terminal; on other terminals the two still run side by side. (#6042)

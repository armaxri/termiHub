### Changed

- Step-by-step automations on different terminals now run side by side: starting one no longer stops
  the one running in another terminal. Two runs still never type into the same terminal; starting
  one there asks first, as before. (#6042)

### Added

- The History says what stopped a run that another automation replaced, for example "“Deploy” was
  started in this terminal". (#6042)
- A terminal that is still waiting for its turn in a run on several terminals can now be stopped.
  (#5984)

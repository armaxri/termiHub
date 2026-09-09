### Fixed

- Editing two General settings fields in rapid succession no longer discards the
  first edit. The General settings inputs rebuilt each change from a captured
  render snapshot, so two changes applied back-to-back before a re-render made the
  second overwrite the first. Changes now compose against the latest state.

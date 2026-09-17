### Changed

- The agent-update prompt now shares the app's standard confirmation-dialog
  behavior: opening it focuses the Cancel button (so an accidental Enter no
  longer triggers the update), and pressing Enter confirms the update when
  Cancel is not focused. The version diff, connected-hosts warning, the update
  button's arrow icon, and all feedback are unchanged (#2924).

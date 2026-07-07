### Fixed

- Workspace restore/launch failures are no longer silent. Restoring the last
  session or launching a saved workspace previously failed quietly (a blank or
  unchanged window with no explanation) when the stored data could not be read
  or when every referenced connection had been deleted. Both paths now surface
  feedback: an error toast ("Could not restore last session" / "Could not launch
  workspace") when the load fails, and a notice ("Previous session had no
  launchable tabs" / `Workspace "X" had no launchable tabs`) when a load
  succeeds but produces no launchable tabs.

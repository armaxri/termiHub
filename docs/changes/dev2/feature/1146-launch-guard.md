### Fixed

- Workspace: launching a workspace is now guarded against re-entry. Previously a
  second double-click or Play press during the multi-second credential-unlock /
  agent-connect phase started a second concurrent launch, racing the two layout
  updates and orphaning terminal sessions. The Launch control now shows a spinner
  and is disabled while a launch is in flight, and repeated presses are ignored
  until the launch settles (#1146).

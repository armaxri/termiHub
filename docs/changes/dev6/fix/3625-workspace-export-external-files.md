### Fixed

- Workspaces: exporting and importing workspaces now resolves connection
  references against external connection files too, not only the main
  connection store. A tab bound to a connection from an enabled external file
  is exported with its portable name and re-imported to the right connection.
  When a reference is ambiguous (an id held by several connection files on
  export, or a name several connections carry on import) it is never guessed:
  the tab keeps its raw reference and the export/import shows a warning naming
  the workspace and the colliding files (#3625).

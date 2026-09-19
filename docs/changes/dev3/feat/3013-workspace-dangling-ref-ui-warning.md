### Added

- Importing a workspace whose tab references a connection that no longer exists
  now surfaces a non-blocking warning in the UI naming the workspace and the
  missing connection, instead of only recording it server-side. The workspace
  still imports and the tab is kept — the warning tells you it will not connect
  until the connection is restored. The `import_workspaces` command now returns
  the imported count together with any such warnings (#3013).

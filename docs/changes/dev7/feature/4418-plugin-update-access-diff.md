### Added

- The plugin install dialog now shows, on an update or a re-install, how the
  access the package requests differs from the installed version (#4418). What
  the update adds — permissions, filesystem folders (the declared
  `${home}`/`${config}` form next to the folder it resolves to) and connection
  policy — appears under a "This update asks for more access" banner; what it
  no longer requests is listed below it. The version row shows the installed
  and the incoming version. The diff is computed from the same access model a
  native plugin's trust acknowledgment binds to, so the dialog and the Native
  Plugins trust row agree. The consent requirement itself is unchanged.

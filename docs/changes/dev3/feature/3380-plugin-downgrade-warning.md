### Added

- Plugins: installing a plugin over an installed copy now compares versions. Replacing it
  with an **older** version, a **different build of the same version**, or a version that
  cannot be compared asks for confirmation first ("Replace X 1.4.0 with older 1.2.0?");
  cancelling leaves the installed plugin untouched. Upgrades and identical reinstalls are
  unchanged (#3380).

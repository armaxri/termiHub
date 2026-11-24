### Changed

- **Run local process needs experimental features for every run** (#5988): with **Allow experimental
  features** off, a workflow that contains or calls a Run local process step no longer runs, whether
  it is started by hand, from the command palette, by a hotkey, on several terminals, by a trigger
  or by a schedule. It is refused before anything is typed, with a message that names the switch.
  **If you had allowed local programs in Settings ▸ Security while experimental features were off,
  those workflows ran before and are refused now**: turn on Settings ▸ General ▸ Allow experimental
  features to keep using them. With experimental features on, nothing changes. The Security opt-in
  and the list of allowed programs still apply on top.

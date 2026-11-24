### Changed

- **One Automations view** (#5818) replaces the Macros and Workflows views: one Activity Bar item
  and one list of every automation, searchable by name, description and tag. Each row shows the
  name, its description and its state (Armed or Off, Running, Failed) with a Run button that
  becomes Stop while it runs. Run on…, Schedule…, Recent runs, Edit…, Duplicate, Export… and
  Delete… are text entries of the row's menu (the … button or a right-click). **New ▾** creates an
  automation step by step or from typed keystrokes and holds Import… and Export all…; **Record** is
  next to it. Schedules and History are sections under the list.
- Automations no longer need **Allow experimental features**. Only the **Run local process** step
  does: with the switch off the editor does not offer it, and an automation that can reach it does
  not run.
- Your hidden Activity Bar views are kept: if you had hidden both Macros and Workflows, Automations
  is hidden; if you had hidden only one, it shows. Once this version has saved its settings, an
  older termiHub does not overwrite them.
- Import reads files exported by either earlier view, and **Export all…** writes the whole library
  to one file that an older termiHub can still import.
- Without an active terminal, Run asks which terminals to run on instead of showing an error.
- The status bar's schedules indicator opens the Schedules section of the Automations view.

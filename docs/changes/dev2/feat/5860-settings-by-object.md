### Changed

- Settings are grouped by what they are about. A new **Connections** group holds **Connection
  defaults** (the default SSH user and key, X11 forwarding and the file browser, which were under
  General), Serial, Monitoring (was under Terminal) and External files. **Schedules** has its own
  **Automation** group, **Plugins** and **Open in termiHub** are under General, and **Import &
  migration** sits beside **Backup & restore**; the folded **Advanced** group keeps only the X
  server and portable mode. Searching by a setting's old place still finds it, and links into
  Settings still land on the right page. No setting changes its value. (#5860)
- Schedules have one list, in the Automations sidebar. **Settings → Automation → Schedules** says
  how many there are and opens that list. (#5860)
- Backing up passwords has one place: **Backup & restore** includes them with everything else.
  Settings → Security → **Back up saved passwords** points there in the words of the chosen store,
  and the separate Export vault / Import vault actions are gone. A password file an older termiHub
  exported still restores in Backup & restore (**Restore passwords from an older export…**). (#5860)
- Settings search no longer leaves the page shown before it marked as selected, says above each
  result which page it is on with a **Show in …** link, and choosing a page ends the search. The
  folded Advanced group names what it holds. (#5860)
- Settings → Schedules says what needs fixing, as the status bar does ("1 will not run"), and
  offers **Fix in automations**; the Schedules list it opens is marked for a moment. (#5860)
- Backup & restore says the saved passwords are in the backup and that the file is locked with a
  passphrase; the Master password option no longer promises a separate export. (#5860)
- Smaller wording and layout fixes in Settings: Power monitoring is called **Host monitoring**,
  the storage-off lines say "Passwords aren't saved", the key file picker is labelled **Choose key
  file…**, Reload of external files waits for a file, Plugins opens with the installed plugins,
  and X11 forwarding and Terminal point to the X server and Appearance pages. (#5860)

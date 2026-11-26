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

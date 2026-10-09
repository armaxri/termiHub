### Security

- Trusting a native plugin now covers the access you approved, not only its
  library file. Before, an update or reinstall that kept the same library but
  asked for more access (for example network access or another folder) loaded
  without asking you again. Now any change to a plugin's permissions, declared
  folders or connection policy needs your approval again. This includes changes
  that only reduce access, so what you approved is always exactly what the
  plugin gets.
- Plugins you trusted before this version show as **needs re-approval** in
  Settings → Plugins → Native Plugins and do not load until you review and trust
  them again. Earlier versions did not record which access you approved.
- The Native Plugins row no longer shows an updated plugin as trusted when its
  trust no longer applies. It says why: the plugin changed, or its permissions
  changed. A **Permissions changed — review** action lists the access the plugin
  asks for before you trust it again.
- Uninstalling a native plugin now removes its trust, so a later reinstall asks
  again.

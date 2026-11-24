### Changed

- **One command palette entry per automation** (#5818), with a bolt and the terminal it runs in.
  Typing "run macro" or "run workflow" still finds it. Without an open terminal it asks where to
  run. "Run automation on broadcast group…" offers every automation.
- **One file format for automations.** Export writes one list; import also reads macro and workflow
  files of older versions. Nothing is lost on the way: typing speed, triggers, values to ask for,
  nested steps and fields a newer version added are kept, and steps that run another automation of
  the file run its imported copy. Exporting one automation takes along the ones it runs. Older
  versions of termiHub cannot read the new file and say so.
- Import and Export all are in **Settings → Import & migration**; New → "Import or export…" in the
  Automations sidebar leads there. After an import a dialog says what needs a look.
- Settings, toasts and prompts say "automation" instead of "macro" and "workflow" (#6005).

### Security

- Imported automations arrive switched off, and switching an automation off now also turns off its
  hotkeys: a key named by an imported file does nothing until you turn the automation on. If you
  had switched off an automation but used its hotkey, turn it on again or run it by hand.

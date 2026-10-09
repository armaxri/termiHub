### Security

- An imported workspace can no longer run commands or open connections on
  your machine without you seeing them first. When you import workspaces, the
  import notice lists every tab that carries a startup command or its own
  connection settings as untrusted, with the exact command and what the
  connection opens. The same applies to a workspace loaded with
  `--workspace-file`.
- An imported tab's startup command now waits for your confirmation on this
  machine. The tab shows **Imported command not yet confirmed** with the
  command and **Confirm and run** / **Don't run**. You can also confirm it in
  the workspace editor before launching. Changing the command needs a new
  confirmation.
- An imported tab with its own connection settings (for example a local shell
  with a custom program) does not connect until you confirm it. The tab shows
  what it would open and offers **Confirm and connect**.
- Workspaces you create or edit yourself are not affected.

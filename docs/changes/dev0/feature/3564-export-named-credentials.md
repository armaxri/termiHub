## Added

- Exporting connections now carries the shared credentials they use: their names always, and their secrets when you export "With credentials (encrypted)". Importing the file on another machine recreates them, so the connections connect without a prompt. An existing shared credential is never overwritten — one with the same name but a different secret is imported as "`<name>` (imported)", and one holding the identical secret is reused. The import result lists anything that needs your attention.

## Security

- In OS Keychain mode, exporting connections with credentials now asks the operating system to confirm it is you (Touch ID, Windows Hello or your account password), like the credential vault export.

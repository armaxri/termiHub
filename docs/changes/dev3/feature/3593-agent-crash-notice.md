### Added

- termiHub now tells you when a **remote agent crashed since it was last
  connected**. After an agent (re)connects, the desktop checks its crash
  reports once over the existing connection and shows one dismissible notice
  per agent, with **View Report** (read over the connection and redacted again
  on your machine) and **Export Diagnostics…**. Reports that already existed
  the first time termiHub checks an agent are not announced, and each crash is
  announced only once. The **Crash Report Notice** setting turns this off too
  (#3593).

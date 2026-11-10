### Fixed

- File browser: renaming, uploading (Upload button or dropping files from the OS) and
  New File no longer silently replace an existing file or folder of the same name, on
  the local and on remote (SSH/SFTP, agent, Docker, FTP) file systems. They now ask
  first in the same "… and Replace?" dialog as move and paste; an upload also offers
  **Keep Both** (saved as `name (1).ext`) and **Skip**. On the local file system the
  rename and New File refuse to clobber atomically even if the file appears after the
  check.

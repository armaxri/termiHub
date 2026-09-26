### Added

- File browser: remote **folders** can now be dragged out to Finder / Explorer / a GTK file
  manager. An SFTP / FTP folder is staged recursively through the Transfer Queue (progress and
  cancel work per file) and then handed to the OS drag with its whole tree. Files and folders from
  **Docker and remote-agent** sessions can be dragged out too — termiHub copies them into a private
  staging folder first. Very large selections (over 4 GiB, or 1 GiB for Docker / agent sessions)
  and trees of more than 10 000 entries are refused with a hint to use Download. (#3491)

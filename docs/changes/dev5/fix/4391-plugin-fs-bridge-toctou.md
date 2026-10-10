### Security

- Plugins can no longer escape their declared filesystem folders by swapping a file or folder for a symbolic link between the permission check and the file being opened: plugin file reads, writes, listings and metadata lookups now open paths through a handle anchored at the declared folder and refuse any link swapped in along the way (#4391).

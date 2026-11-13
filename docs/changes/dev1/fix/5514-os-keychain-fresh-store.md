### Fixed

- Choosing **OS Keychain** in the first-save chooser no longer leaves the store
  unusable. On macOS a keychain item that an earlier, differently signed
  termiHub build wrote (every unsigned build gets a new identity) cannot be read
  by the current build. termiHub treated that as a read failure even for
  credentials it had never stored, so every connection failed to resolve its
  saved secrets and switching to another store was refused, stranding you in
  OS-keychain mode. Such items now count as absent unless termiHub itself
  recorded storing a secret there, and a store switch no longer stops at keys
  it never stored. Credentials termiHub did store stay protected: an unreadable
  one still blocks the switch. Keychain errors in the log now name the
  underlying error and macOS status code, and saving over such a leftover item
  explains how to clear it.

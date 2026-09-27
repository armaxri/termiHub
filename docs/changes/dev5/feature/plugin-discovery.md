### Added

- **Browse Plugins** in Settings → Plugins: load a curated plugin index, search
  it, and see each plugin's compatibility with this computer (plugin ABI,
  platform, build toolchain, native code) and whether it is installed or has
  an update. The index is fetched only when you click **Load plugin index**;
  the default is the termiHub-maintained list, which starts empty, and the
  **Plugin Index URL** setting can point to another HTTPS index (#3715).
- **Install from URL** in Settings → Plugins: paste an HTTPS link to a
  `.termihub-plugin` file and its SHA-256 checksum (#3715).
- Both install paths download in the background over HTTPS only, reject a
  package whose checksum does not match before opening it, and then show the
  same install dialog as **Install from file…**. Trust, permissions and
  confirmations work as before, and nothing is installed or trusted
  automatically.

### Changed

- Plugin update downloads now stream to a private temporary file and are
  checksum-verified before they are opened, instead of being held in memory.

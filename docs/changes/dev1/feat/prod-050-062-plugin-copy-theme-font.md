### Changed

- The plugin install/trust dialog now plainly warns, before you install, that a
  plugin shipping a **native terminal backend** runs **unsandboxed with full
  application privileges**. The warning states that once enabled such a plugin
  can access anything termiHub can — files, network, and credentials —
  regardless of the coarse permissions listed, so you can make an informed trust
  decision. Plugins that only contribute JS/JSON extension points (protocol
  parsers, themes, status-bar widgets) do not show the warning (PROD-050).

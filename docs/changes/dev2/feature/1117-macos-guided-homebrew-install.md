### Changed

- macOS X11 setup: when installing XQuartz needs Homebrew but Homebrew isn't
  installed, termiHub now guides you through installing Homebrew instead of
  dead-ending on a manual-download message. The X-server setup / connect-consent
  dialogs offer an **Install Homebrew** action that opens a local terminal tab
  pre-loaded with the official Homebrew installer (you drive the real
  `sudo` / RETURN prompts — nothing is installed silently), plus an **Open
  xquartz.org** link if you'd rather install XQuartz manually. After Homebrew is
  installed, **Retry** re-detects it and runs `brew install --cask xquartz` as
  before. termiHub never hosts or redistributes XQuartz (#1117, epic #1047).

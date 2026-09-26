### Added

- Terminal: **OSC 133 command marks** (semantic prompts). When the shell marks its
  prompts and commands — termiHub's shell integration now does this for bash, zsh,
  PowerShell, fish 3.x and (prompt marks only) cmd; fish 4+ and other integrations
  that emit OSC 133 work too — you can:
  - **Jump to Previous / Next Prompt** (<kbd>Cmd</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> on
    macOS, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> on
    Windows/Linux); the target prompt row is briefly highlighted.
  - **Select Last Command Output** and **Copy Last Command Output** from the
    command palette (unbound by default; bindable in Settings → Keyboard
    Shortcuts).
  - See a thin green/red **status mark** in the left gutter next to each finished
    command's prompt (success/failure). Toggle it with **Settings → Terminal →
    Command Status Marks** (on by default).

  Shells that emit no OSC 133 behave exactly as before: the actions are disabled
  in the palette and the prompt-jump keys still reach the shell (#3415, PROD-059).

### Changed

- Shell integration: the injected bash/zsh prompt hook now runs **first** in
  `PROMPT_COMMAND` / `precmd_functions` (so it sees the finished command's exit
  status, which it preserves for later hooks), appends a zero-width OSC 133 mark to
  `PS1`, and is idempotent. The PowerShell prompt override preserves
  `$LASTEXITCODE` (#3415).

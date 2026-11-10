### Fixed

- Tabs: closing a tab now asks the same question whether you press Cmd/Ctrl+W, click the
  tab's ×, middle-click it or use its context menu (#5189). Before, the shortcut asked
  about every tab, even ones with nothing running, and said work "will be lost" for
  persistent sessions that keep running. Now:
  - only a tab with a live session asks to confirm;
  - a persistent session gets the "keeps running in the background" notice;
  - exited, settings and saved editor tabs close at once;
  - every path offers "Don't ask again" and the Reopen toast.

  The three close-confirmation settings stay as they were. **Confirm before closing a tab
  via keyboard shortcut** now only covers the shortcut's live-session and tab-group
  prompts, and "Don't ask again" in a dialog the shortcut opened turns that setting off.

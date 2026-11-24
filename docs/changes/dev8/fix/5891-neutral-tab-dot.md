### Fixed

- Terminal tabs: a tab with command marks (shell integration) on no longer shows
  the green connected dot while its shell is still starting or waits at a
  startup question. The dot stays a neutral dashed ring, named "Waiting for the
  shell's first prompt", until the shell reaches its first prompt, then turns
  connected. Tabs without shell integration keep the connected dot as before.

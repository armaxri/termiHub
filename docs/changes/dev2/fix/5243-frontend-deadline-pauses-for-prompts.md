### Fixed

- **A terminal tab no longer fails while you answer its SSH prompt.** The tab's own
  90-second connect limit now pauses while its host-key trust prompt or one-time-code
  prompt is open, and resumes when you answer. Before, taking more than 90 seconds to
  compare a fingerprint or fetch a code failed the tab with "Connection did not complete
  within 90 s", even though the connect was still waiting for you. A prompt nobody
  answers still ends the connect after 5 minutes. Prompts of other tabs do not affect
  this tab (#5243).

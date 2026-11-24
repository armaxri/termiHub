### Changed

- Undo offers ("Closed “web” · Reopen", "Deleted folder … · Undo") use the neutral info toast
  style instead of the green success one. Closing several tabs now lists the first three tab
  names under "Closed N tabs", then "+N more" (#5956).
- The SSH connection security popover shows the sign-in key's file name, with the full path on
  hover, under a sentence-case "Connection security" title (#5956).
- An agent shell tab keeps the whole agent name and its " · bash" suffix; the name is shortened
  from its end only when the tab is too narrow (#5956).
- The agent setup summary reads `Agent v0.1.0 (develop) installed at ~/.local/bin/termihub-agent.`
  instead of nesting the branch in parentheses (#5956).
- The agent's built-in connection is named "Default shell". An untouched "Default Shell" created
  by an older agent is renamed; a connection you named or edited yourself is left alone (#5956).

### Fixed

- Agents: a failed Windows agent setup could show "Agent installed", because
  Windows reports exit code 0 for a failed setup too. termiHub now checks the
  host once the setup ended: the tab says "Agent installed" only when the
  uploaded agent is really in place and runs, "Agent setup failed" when it is
  not (also when an older agent was left in place), and "Agent setup outcome
  unknown" when the host could not be checked. The agent's row follows the same
  three outcomes (#5992).
- Agents: the Windows agent setup typed its commands with a line ending that
  PowerShell does not take as Enter, so they may not have run there (#5992).

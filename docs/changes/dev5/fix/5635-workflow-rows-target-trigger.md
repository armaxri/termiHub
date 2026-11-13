### Fixed

- Workflow rows in the Workflows sidebar show a muted second line under the
  name saying how the workflow is launched and what it targets (for example
  "On output match · prod-web" or "Manual"), and a workflow whose trigger runs
  it automatically carries an "Armed" marker that names the watched
  connections.
- Workflow run history names the terminal each run went to, so two runs of the
  same workflow on different terminals are no longer identical rows.
- The "Run on…" summary toast pluralises properly ("on 2 terminals", "on 1
  terminal") instead of "terminal(s)".

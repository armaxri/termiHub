### Fixed

- The Transfer Queue row for a copy/paste between SFTP locations is now named
  after the file you pasted, instead of the internal temp file termiHub copies
  it through. Pasting `report.csv` showed an upload row named
  `termihub-paste-1784278708447-report.csv` — a scratch name that never
  belonged on screen — even though the row's path column already pointed at
  `report.csv`. A transfer row's name is now always the base name of the remote
  path shown beside it, so the two can no longer disagree. Ordinary uploads,
  where the local and destination names already match, are unaffected.

### Added

- **Export Diagnostics** can now include crash reports from connected remote
  agents. The preview lists each connected agent's reports with a checkbox to
  include or leave them out; they are fetched over the existing agent
  connection only, capped in size, and redacted again on your machine before
  the zip is written. Agents too old to share crash reports are skipped with a
  note (#3574).

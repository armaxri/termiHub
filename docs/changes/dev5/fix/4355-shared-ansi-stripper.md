### Fixed

- Workflows: on-output-match triggers and `wait-for-output` steps now strip OSC
  escape sequences (window titles, OSC 7 working directory, OSC 8 hyperlinks and
  the OSC 133 shell-integration marks) before matching, as well as colon-form
  colours and bracketed-paste markers. Previously a pattern anchored to the end
  of a prompt, such as `\$ $`, never matched over SSH with shell integration on,
  because the text still carried `]133;B` and raw control bytes. An escape
  sequence split across two output chunks is now stripped too (#4355).

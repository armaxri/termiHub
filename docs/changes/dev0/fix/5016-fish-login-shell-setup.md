### Fixed

- SSH: a session to a host whose login shell is fish no longer starts with a fish parse
  error when "Command Marks (Shell Hook)" is on. The shell probe now tells fish apart from
  bash/zsh. fish 4.0+ reports its directory and command marks itself, so nothing is typed
  into it. fish 3.x gets a fish-syntax hook instead of the bash one. The configured
  environment variables and the X11 display are set with fish's `set -gx` and fish
  quoting, and those lines are kept out of fish's history (#5016).

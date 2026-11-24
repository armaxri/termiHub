### Fixed

- Agent setup: the setup terminal no longer prints raw octal escapes such as
  `\360\237\232\200 === termiHub Agent Setup ===`. The setup script now prints
  plain-ASCII progress markers (`[..]`, `[ok]`, `[error]`) with `printf`, so the
  output reads the same on any remote shell and locale. It ends in one summary
  line, `Agent installed (v<version>) at <path>. You can close this tab.`, or
  `Agent setup failed: <reason>` when a step fails. The script also cleans up its
  own upload directory, so the terminal shows a single short `sh` command instead
  of `rm -f`/`rmdir` lines (#5822).
